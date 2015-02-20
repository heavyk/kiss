'use strict'

const resolve = require('resolve-path')
const rawBody = require('raw-body')
const mime = require('mime-types')
const assert = require('assert')
const path = require('path')
const etag = require('etag')
const fs = require('mz/fs')
const ms = require('ms')

module.exports = Kiss

function Kiss(options) {
  if (!(this instanceof Kiss)) return new Kiss(options)

  this.options = options || Object.create(null)
  if (this.options.cacheControl !== undefined) this.cacheControl(this.options.cacheControl)
  if (typeof this.options.etag === 'function') this.etag(this.options.etag)
  if (this.options.hidden !== undefined) this.hidden(this.options.hidden)

  this._folders = []
}

/**
 * Pretend Kiss is a generator function so `app.use()` works.
 * https://developer.mozilla.org/en-US/docs/Web/JavaScript/Reference/Global_Objects/GeneratorFunction
 * Can be removed when ES7 async functions are merged in.
 */

/* istanbul ignore next */
Kiss.prototype.constructor = Object.getPrototypeOf(function* () {}).constructor

/**
 * Support .call() for middleware dispatchers.
 */

Kiss.prototype.call = function* (context, next) {
  yield* next

  let res = context.response

  // push dependencies if the response is already handled
  if (res.body != null) yield* this.serveDependencies(context, next)

  // return if response is already handled
  if (res.body || res.status !== 404) return

  // try to serve the response
  let served = yield* this.serve(context, next)
  // push the dependencies if the response was served
  if (served !== false) yield* this.serveDependencies(context, next)
}

/**
 * Push the current request's dependencies.
 * Note that if the response is currently streamed,
 * which is default for files,
 * the entire stream will be buffered in memory
 */

Kiss.prototype.serveDependencies = function* (context) {
  // http2 push is not supported
  let req = context.req
  if (!req.isSpdy) return

  // not a supported dependency type
  let res = context.response
  let type = res.is('html', 'css', 'js')
  if (!type) return

  // buffer the response
  let body = res.body
  if (Buffer.isBuffer(body)) body = body.toString()
  if (!body) return // empty strings or buffers
  if (body._readableState) body = res.body = yield rawBody(body, { encoding: 'utf8' })
  if (!body) return // empty streams
  yield this.pushDependencies(req.path, type, body)
}

/**
 * Serve a file as the response to the request.
 * Note: assumes you're using your own compression middleware.
 * TODO: maybe handle compression here
 */

Kiss.prototype.serve = function* (context) {
  let req = context.request
  let pathname = req.path
  let stats = yield* this.lookup(pathname)
  if (!stats) return false

  let res = context.response
  switch (req.method) {
    case 'HEAD':
    case 'GET':
      break
    case 'OPTIONS':
      res.set('Allow', 'OPTIONS,HEAD,GET')
      res.status = 204
      return
    default:
      res.set('Allow', 'OPTIONS,HEAD,GET')
      res.status = 405
      return
  }

  res.status = 200
  if (stats.mtime instanceof Date) res.lastModified = stats.mtime
  if (typeof stats.size === 'number') res.length = stats.size
  res.type = stats.type || path.extname(stats.pathname)
  res.etag = yield this._etag(stats)
  res.set('Cache-Control', this._cacheControl)

  let fresh = req.fresh
  switch (req.method) {
    case 'HEAD':
      if (fresh) res.status = 304
      return
    case 'GET':
      if (fresh) return res.status = 304
      res.body = fs.createReadStream(stats.filename)
      return
  }
}

/**
 * Mount a path as a static server.
 * Like Express's `.use()`, except `.use()` in this instance
 * will be reserved for middleware.
 */

Kiss.prototype.mount = function (prefix, folder) {
  if (typeof folder !== 'string') {
    // no prefix
    folder = prefix
    prefix = '/'
  }

  assert(prefix[0] === '/', 'Mounted paths must begin with a `/`.')
  if (!/\/$/.test(prefix)) prefix += '/'

  this._folders.push([prefix, path.resolve(folder)])
  return this
}

/**
 * Use middleware for this server.
 */

/* istanbul ignore next */
Kiss.prototype.use = function () {
  throw new Error('Not implemented.')
}

/**
 * Transform files.
 */

/* istanbul ignore next */
Kiss.prototype.transform = function () {
  throw new Error('Not implemented.')
}

/**
 * Alias a path as another path.
 * Essentially a symlink.
 * Should support both files and folders.
 */

/* istanbul ignore next */
Kiss.prototype.alias = function () {
  throw new Error('Not implemented.')
}

/**
 * Define a custom, virtual path.
 * Ex. kiss.define('/polyfill.js', (context, next) -> [stats])
 */

/* istanbul ignore next */
Kiss.prototype.define = function () {
  throw new Error('Not implemented.')
}

/**
 * Lookup function.
 * TODO: lookup middleware
 */

Kiss.prototype.lookup = function* (pathname) {
  var stats = yield* this.lookupFilename(pathname)
  if (stats) return stats
}

/**
 * Lookup a web path such as `/file/index.js` based on all the support paths.
 * This is the default lookup function.
 */

Kiss.prototype.lookupFilename = function* (pathname) {
  // if options.hidden, leading dots anywhere in the path can not be handled
  if (!this.options.hidden && pathname.split('/').filter(Boolean).some(hasLeadingDot)) return

  for (let pair of this._folders) {
    let prefix = pair[0]
    if (pathname.indexOf(prefix) !== 0) continue
    let folder = pair[1]
    let suffix = pathname.replace(prefix, '')
    if (!suffix || /\/$/.test(suffix)) suffix += 'index.html'
    let filename = resolve(folder, suffix)
    // TODO: make sure symlinked folders work
    let stats = yield fs.stat(filename).catch(ignoreENOENT)
    if (!stats) continue
    // TODO: handle directories?
    if (!stats.isFile()) continue
    stats.mount = pair
    stats.type = mime.contentType(path.extname(filename))
    stats.filename = filename
    stats.pathname = pathname
    return stats
  }
}

/**
 * Set the etag function with caching.
 * Assumes the etag function is always async.
 */

Kiss.prototype.etag = function (fn) {
  assert(typeof fn === 'function')
  this._etag = function (stats) {
    return Promise.resolve(stats.etag || (stats.etag = fn(stats)))
  }
  return this
}

/**
 * Set the default etag function.
 * Requires `stat.mtime` and `stat.size`.
 */

Kiss.prototype.etag(function (stats) {
  return etag(stats, {
    weak: true
  })
})

/**
 * Set the cache control.
 * TODO: support actual cache control headers
 */

Kiss.prototype.cacheControl = function (age) {
  // human readable string to ms
  if (typeof age === 'string') age = ms(age)
  // ms to seconds
  age = Math.round(age / 1000)
  this._cacheControl = 'public, max-age=' + age
  return this
}

/**
 * Set the default cache control, which is about a year.
 */

Kiss.prototype.cacheControl(31536000000)

/**
 * Enable or disable hidden file support.
 */

Kiss.prototype.hidden = function (val) {
  this.options.hidden = !!val
  return this
}

/**
 * Ignore missing file errors on `.stat()`
 */

/* istanbul ignore next */
function ignoreENOENT(err) {
  if (err.code !== 'ENOENT') throw err
}

/**
 * Check if a string has a leading dot,
 * specifically for ignoring parts of a path.
 */

function hasLeadingDot(x) {
  return /^\./.test(x)
}
