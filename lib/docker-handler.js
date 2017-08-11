'use strict'

const log     = require('d1-logger')
const debug   = require('debug')('sky-node:DockerHandler')
const Promise = require('bluebird')
const http    = require('http')
const Tar     = require('tar-fs')
const tar     = require('tar')
const path    = require('path')
const fs      = Promise.promisifyAll(require('fs-extra'))
const inspect = require('util').inspect
// inspect.defaultOptions = { colors: true, breakLength: 1, depth: 4 } // inside this class, somehow, dockerode's callback error pops up when using inspect for unknown reasons

/**
 * Helper class that provides promisified dockerode's API and some additional helper methods that are shared among two project SkyNode and Frontend Nginx
 * @param {Object} docker - docker object from dockerode
 */
var DockerHandler = function (docker) {
	this.docker = docker
}

/**
 * Inspect image
 * @param {string} id - id or name of image
 * @returns {Promise.<Object>} - data of image
 *
 */
DockerHandler.prototype.inspectImage = function (id) {
	var image = this.docker.getImage(id)
	return new Promise((resolve, reject) => {
		image.inspect((err, data) => {
			if (!!err) {
				debug(`Inspecting image ${id}: failed. ${err.message}`)
				reject(err)
				return
			}
			resolve(data)
		})
	})
}

/**
 * Inspect container
 * @param {string} con_id - id or name of container
 * @returns {Promise.<Object>} - data of container
 *
 */
DockerHandler.prototype.inspectContainer = function (con_id) {
	var container = this.docker.getContainer(con_id)
	return new Promise((resolve, reject) => {
		container.inspect((err, data) => {
			if (!!err) {
				debug(`Inspecting container ${con_id}: failed. ${err.message}`)
				reject(err)
				return
			}
			resolve(data)
		})
	})
}

/**
 * Retrieve status object obtained from inspection of a container. The returned object has a manually added properties dubbed as duration of the container since the last operation.
 * It is similar to the {@link inspectContainer}, but some additional fields are added to the resulting object. i.e.:
 * {
 *   ...
 *   State: {
 *     Running: false,
 *     Status: 'non-existent',
 *     Duration: 'N/A'
 *   }
 *   ...
 * }
 * @return {Promise.<Object>} The desirable properties are located inside the State object of the returned object.
 */
DockerHandler.prototype.inspectContainerStatus = function (name) {
	return Promise.try( _ => this.inspectContainer(name) )
		.then( container => {
			container.State.Duration = container.State.Running ? this._getMilisecFriendly(Date.parse(container.State.StartedAt)) : this._getMilisecFriendly(Date.parse(container.State.FinishedAt))
			return container
		})
		.catch( err => {
			debug(`Inspecting container ${name}: failed. ${err.message}`)
			return {
				State: {
					Running: false,
					Status: 'non-existent',
					Duration: 'N/A'
				}
			}
		})
}

/**
 * Convert miliseconds to readable string
 * @param {number} val - old moment when container is attached to (in miliseconds)
 * @returns {string} seconds/minutes/hours/days
 */

/**
 * Inspect network
 * @param {string} id - network id/name
 * @returns {Promise.<Object>} - data of container
 *
 */
DockerHandler.prototype.inspectNetwork = function (id) {
	var network = this.docker.getNetwork(id)
	return new Promise((resolve, reject) => {
		network.inspect((err, data) => {
			if (!!err) {
				debug(`Inspect network ${id}: fails. ${err.message}`)
				reject(err)
				return
			}
			resolve(data)
		})
	})
}

DockerHandler.prototype.startContainer = function (con_id, opts) {
	var container = this.docker.getContainer(con_id)
	return new Promise((resolve, reject) => {
		container.start(opts, (err, data) => {
			if (!!err) {
				log.warn(`Container ${con_id} start fails. Error: ${err.message}`)
				reject(err)
				return
			}
			debug(`Container ${con_id} start succeeds`)
			resolve(data)
		})
	})
}

/**
 * Like run command from Docker's CLI
 * @param {string} image - Image name to be used.
 * @param {Array} cmd - Command to run in array format.
 * @param {Object} streamo - Output stream
 * @param {Object} createOptions - Container create options (optional)
 * @param {Object} startOptions - Container start options (optional)
 */
DockerHandler.prototype.run = function (image, cmd, streamo, createOptions, startOptions) {
	return new Promise((resolve, reject) => {
		this.docker.run(image, cmd, streamo, createOptions, startOptions, (err, data, container) => {
			if (!!err) {
				log.warn(`Image ${image} run fails. Error: ${err.message}`)
				reject(err)
				return
			}
			debug(`Image ${image} run succeeds`)
			resolve({
				data: data,
				container: container
			})
		})
	})
}

/**
 * Docker exec. Cannot use Promisify because some classes are not exposed to the external world.
 * In fact, many dockerode functions have two return options, one calls the input callback,
 * one returns a promise if the input callback is not provided. However, many cases, I failed to test
 * the promise-in-return case. Therefore, I stick with this manual promisification.
 *
 * @param {Object} container
 * @param {Array.<String>} cmd - array of alphanumeric strings that forms a complete command
 * @returns {Promise.<Object>} execution object
 */
DockerHandler.prototype.exec = function (container, cmd) {
	let options = {
		Cmd: cmd,
		AttachStdout: true,
		AttachStderr: true
	};
	return new Promise((resolve, reject) => {
		container.exec(options, function (err, exec) {
			if (err != null) {
				reject(err);
				return
			}
			exec.start((err, stream) => {
				if (err != null) {
					reject(err)
					return;
				}
				stream.pipe(process.stdout, {end: true})
				stream.on('end', _ => {
					exec.inspect((err, data) => {
						if (err != null) {
							Log.error(`Docker exec inspect failed: ${err.message}`)
							reject(err);
							return
						}
						debug(`exec start inspect data: ${inspect(data)}`)
						if (data == null || data.Running || data.ExitCode != 0) {
							Log.error(`Docker exec failed: unexpected inspection result`)
							reject(err)
							return
						}
						resolve(data)
					});
				});
			});
		});
	})
}

/**
 * Copy file from docker container to local machine. This function gets the archive from the container,
 * extract, and then remove it after successful extraction
 *
 * @param {Object} container - Docker container to be backup
 * @param {string} src - Source file
 * @param {string} dst_dir - Destination directory
 * @returns {Promise.<void>}
 */
DockerHandler.prototype.copyDockerFiles = function (container, src, dst_dir) {
	let tarName = Math.random().toString() + '.tar'
	let tarFile = path.join(dst_dir, tarName)
	let xtractOpts = {
		cwd: dst_dir, // extraction directory
		file: tarFile, // the archive file to extract
		sync: false,
	}
	return new Promise.try(_ => container.getArchive({path: src})) // Getting tarball of source file from container, returned data is an http.IncomingMessage stream
		.then(stream => this._writeTarball(stream, dst_dir, tarName))
		.then(_ => tar.x(xtractOpts)) // extract tarball
		.then(_ => fs.remove(tarFile))
		.catch( err => {
			log.error(`Docker cp ${src} to ${dst_dir} of container ${container.Id} failed`)
			throw err
		})
}

/**
 * Write data from stream to file
 * @param {Object} stream
 * @param {string} dir
 * @param {string} filename
 * @return {Promise.<void>}
 * @private
 */
DockerHandler.prototype._writeTarball = function (stream, dir, filename) {
	let file = path.join(dir, filename)

	return Promise.try(_ => fs.mkdirsAsync(dir))
		.then(_ => fs.openAsync(file, 'w'))
		.then(_ => fs.createWriteStream(file))
		.then(writable => {
			return new Promise((resolve, reject) => {
				stream.pipe(writable)
				stream.on('end', _ => {
					debug(`Stream ${filename} ends. Resolved`)
					resolve()
				})
				stream.on('close', _ => {
					debug(`Stream ${filename} closes. Resolved`)
					resolve()
				})
				stream.on('error', err => {
					debug(`Stream ${filename} error. Rejected. ${inspect(err)}`)
					reject(err)
				})
			})
		})

}

// /**
//  * Copy file from docker container to local machine
//  * @param {Object} container
//  * @param {string} src
//  * @param {string} dst_path
//  * @param {string} dst_file
//  * @returns {Promise.<>}
//  */
// DockerHandler.prototype.copyDockerFiles = function (container, src, dst_path, dst_file) {
// 	let dst = dst_path.endsWith('/') ? [dst_path, dst_file].join('') : [dst_path, dst_file].join('/')
// 	return new Promise.try( _ => container.getArchive({ path: src }) ) // Getting tarball of source file from container
// 		.then(incomming_message => {
//             debug(`incomming_message instanceof http.IncomingMessage ? ${incomming_message instanceof http.IncomingMessage}`)
//             return this._writeStream(incomming_message, dst_path)
// 		})
//
// }
//
//
// DockerHandler.prototype._writeStream = function (stream, file) {
//     debug(`Streaming file ${file}`)
// 	return new Promise((resolve, reject) => {
// 		stream.pipe(Tar.extract(file)) // [BUG] synchronization problem with event end/close - Unhandled stream error in pipe Didn't get expected byte count fs-stream
// 		stream.on('end', _ => {
// 			debug(`Stream ends. Resolved`)
// 			resolve()
// 		})
// 		stream.on('close', _ => {
// 			debug(`Stream closed. Resolved`)
// 			resolve()
// 		})
// 		stream.on('error', err => {
// 			debug(`Stream error. Rejected. ${JSON.stringify(err)}`)
// 			reject(err)
// 		})
// 	})
// }

/**
 * List all available networks
 * @returns {Promise.<Array.<Object>>}
 */
DockerHandler.prototype.listNetworks = function () {
	return Promise.try(_ => this.docker.listNetworks({})) // Attention: this function mix asynchronous call and promise. Take care of future updates from dockerode's authors
		.then(networks => {
			return networks == null ? null : networks.map(network => {
				let cast = this.getNetwork(network.Id)
				for (let prop in network) {
					if (!network.hasOwnProperty(prop)) {
						continue
					}
					cast[prop] = network[prop]
				}
				return cast
			})
		})
		.catch(err => {
			log.warn(`Listing networks fails. Error: ${err.message}`)
			throw err
		})
}

/**
 * Search for network having name of siteNetworkName. docker.getNetwork requires input id
 * @param {string} name
 * @returns {Promise.<Object>}
 */
DockerHandler.prototype.getNetworkByName = function (name) {
	return this.listNetworks()
		.then(networks => {
			if (networks == null) return null
			return networks.filter(network => {
				return network.Name === name
			})
		})
		.then(results => {
			if (results == null || results.length == 0) { // network not found
				throw new Error(`No networks named ${name} found`)
			} else if (results.length > 1) {
				throw new Error(`More than one networks exist with name ${name}`)
			}
			return results[0]
		})
}

/**
 * Find list of matching containers
 * @param name
 * @returns {Promise.<TResult>}
 */
DockerHandler.prototype.listContainersByName = function (name) {
	return Promise.promisify(this.docker.listContainers).bind(this.docker)
	({
		filters: {
			name: [name]
		}
	})
		.then(conts => {
			// Create dockerode container objects from pure Javascript object
			let clone;
			if (conts != null) {
				clone = conts.map(cont => {
					let obj = this.docker.getContainer(cont.Id);
					for (let prop in cont) {
						obj[prop] = cont[prop];
					}
					return obj;
				})
			}
			debug(`Found ${conts.length} containers named ${name}`)
			return clone
		})
		.catch(err => {
			log.warn(`Listing containers by name fails. Error: ${err.message}`)
			throw err
		})
}

/**
 * Connect container from network
 * @param container
 * @param network
 * @returns {Promise.<>}
 */
DockerHandler.prototype.connectContainerToNetwork = function (container, network) {
	return new Promise((resolve, reject) => {
		network.connect({container: container.Id}, (err, data) => {
			if (!!err) {
				reject(err)
				return
			}
			resolve(data)
		})
	})
}

/**
 * Disconnect container from network
 * @param {Container} container - nginx container to be disconnected
 * @param {Network} network - site network
 * @returns {Promise.<>}
 */
DockerHandler.prototype.disconnectContainerFromNetwork = function (container, network) {
	return new Promise((resolve, reject) => {
		network.disconnect({
			container: container.Id,
			force: true
		}, (err, data) => {
			if (!!err) {
				log.error(`Disconnecting network and container ${container.Id}: failed`)
				reject(err)
				return
			}
			resolve(data)
		})
	})
}

/**
 * Find existing volume data. Check if there already exist a volume that was
 * previously created for a site with the same name, but was only `down`-ed and not `nuke`-ed.
 *
 * volumeData = site_name + '_db-data'
 * volumeKeys = site_name + '_db-keys'
 * volumeLogs = site_name + '_db-logs'
 *
 * @param {Array.<string>} volumes - list of volumes to be inspected
 * @return {Promise.<Array.<Object>>} - nullable array of matched volume objects
 */
DockerHandler.prototype.findExistingVolumes = function (volumes) {
	let params = {
		filters: {
			'name': volumes
		}
	}
	return Promise.try( _ => this.docker.listVolumes(params) )
		.then( data => {
			let ret = data == null ? null : data.Volumes
			debug(`Finding volumes ${JSON.stringify(volumes)} gives results: ${ret}`)
			return ret
		})
		.catch( err => {
			log.error(`Find volumes ${JSON.stringify(volumes)} fails`)
			throw err
		})
}

/**
 * Check existence of network by name/raw-id
 * @param {string} name of raw-id of network
 * @returns {Promise.<boolean>}
 */
DockerHandler.prototype.doesNetworkExist = function (id) {
	return this.inspectNetwork(id)
		.then( _ => true)
		.catch (err => false )
}

/**
 * Check existence of network by name/raw-id
 * @param {string} name of raw-id of network
 * @returns {Promise.<boolean>}
 */
DockerHandler.prototype.doesImageExist = function (id) {
	return this.inspectImage(id)
		.then( _ => true )
		.catch( err => false )
}

/**
 * Check existence of container by name/raw-id
 * @param {string} name of raw-id of network
 * @returns {Promise.<boolean>}
 */
DockerHandler.prototype.doesContainerExist = function (id) {
	return this.inspectContainer(id)
		.then( _ => true )
		.catch( err => false )
}

/**
 * Check existence of containers by names/raw-ids
 * @param {Array.<string>} ids - names or raw-ids of containers
 * @returns {Promise.<Array.<boolean>>} - boolean status of containers
 */
DockerHandler.prototype.doContainersExist = function (...ids) {
	let pz = [...ids].map(id => this.doesContainerExist(id))
	return Promise.all(pz)
}

/**
 * Check existence of network by name/raw-id and create one
 * @param {string} name of raw-id of network
 * @returns {Promise.<boolean>}
 */
DockerHandler.prototype.createOverlayNetwork = function (id) {
	return Promise.try(_ => this.doesNetworkExist(id))
		.then(exist => {
			if (exist) {
				log.warn(`Network ${id} already exists`)
				return
			}
			return Promise.promisify(this.docker.createNetwork.bind(this.docker))({
				"Name": id,
				"Driver": "overlay",
			})
			.then(_ => debug(`Creating overlay network ${id}: done`))
		})
		.catch(err => {
			log.error(`Creating overlay network ${id}: failed`)
			throw err
		})
}

/**
 * Build docker image
 * @param {string} file - location to file
 * @param {Object} opts - options
 * @return {Promise.<>}
 */
DockerHandler.prototype.buildImage = function (file, opts) {
	return new Promise((resolve, reject) => {
		this.docker.buildImage(file, opts, (err, stream) => {
			if (err != null) {
				reject(err)
				return
			}
			stream.pipe(process.stdout, {end: true})

			this.docker.modem.followProgress(stream, (err, output) => {
				if (err == null) {
					resolve()
					return
				}
				if (typeof err == 'object') {
					reject(err)
					return
				}
				if (typeof err == 'string') {
					reject(new Error(err))
					return
				}
				reject(err)
			});
		})
	})
}

/**
 * Get container by name or id
 * @param id
 */
DockerHandler.prototype.getContainer = function (id) {
	return this.docker.getContainer(id)
}

/**
 * Get network by name or id
 * @param id
 */
DockerHandler.prototype.getNetwork = function (id) {
	return this.docker.getNetwork(id);
}


/**
 * TODO externalize to a global Helper
 * @param val
 * @return {*}
 * @private
 */
DockerHandler.prototype._getMilisecFriendly = function (val) {
	if (val < 0) {
		return ''
	}
	val = Date.now() - val
	let secs = val / 1000;
	if (secs < 120) {
		return secs.toFixed(2) + 's ago'
	}
	let mins = secs / 60
	if (mins < 120) {
		return mins.toFixed(2) + 'm ago'
	}
	let hours = mins / 60
	if (hours < 48) {
		return hours.toFixed(2) + 'h ago'
	}
	let days = hours / 24
	return days.toFixed(2) + 'd ago'
}

DockerHandler.CONTAINER = {
	STATUS: {
		created: 'created',
		restarting: 'restarting',
		running: 'running',
		paused: 'paused',
		exited: 'exited'
	}
}

module.exports = DockerHandler