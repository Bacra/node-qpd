'use strict';

var fs		= require('fs');
var path	= require('path');
var events	= require('events');
var extend	= require('extend');
var mkdirp	= require('mkdirp');
var debug	= require('debug')('abq');

var concat	= Array.prototype.concat;


exports = module.exports = main;
exports.cls = ADQ;
exports.defaults = {
	file			: null,
	fd				: null,
	flag			: 'a+',
	writeLength		: 100,
	// fd还没创建 日志过满的时候
	maxLength		: 10000,
	writeInterval	: 600,
	maxRetry		: 2
};

function ADQ(opts) {
	this.opts		= extend({}, exports.defaults, opts);
	this.waitQuery	= [];
	this.writeQuery	= [];

	if (this.opts.maxLength && this.opts.maxLength < this.opts.writeLength) {
		this.opts.maxLength = this.opts.writeLength;
	}

	// 声明一下会用到的成员变量
	this.fd = this.opts.fd;
	this._writing = this._destroyed = false;
	this._genfd = new GenFd();

	events.EventEmitter.call(this);
}

require('util').inherits(ADQ, events.EventEmitter);

extend(ADQ.prototype, {
	init_: function() {
		if (this._inited) return;
		this._inited = true;

		if (this.opts.writeInterval) {
			// 定期日志写入文件
			setInterval(this.write.bind(this), this.opts.writeInterval);
		}

		bindProcess();
	},
	/**
	 * 写数据的入口
	 * @param  {String} msg
	 */
	handler: function(msg) {
		if (this._destroyed) return debug('no msg: has destroyed');

		var self		= this;
		var waitQuery	= self.waitQuery;
		var len			= waitQuery.length;
		var opts		= self.opts;

		waitQuery.push(Buffer.isBuffer(msg) ? msg : new Buffer(typeof msg == 'string' ? msg : ''+msg));

		if (self.fd) {
			if (len > opts.writeLength) {
				self.write();
			}
		} else if (opts.maxLength && len > opts.maxLength) {
			var splitLen = len - opts.writeLength;
			waitQuery.splice(0, splitLen);
			debug('logfd: empty msg query %d', splitLen);
			self.emit('empty', splitLen);
		} else if (opts.file) {
			self.genfd(opts.file);
		}
	},
	write: function() {
		this.toWriteQuery();
		this.flush();
	},
	writeSync: function() {
		this.toWriteQuery();
		this.flushSync();
	},
	flush: function() {
		this._doFlush(false);
	},
	flushSync: function() {
		this._doFlush(true);
	},
	toWriteQuery: function() {
		this.writeQuery.push(this.waitQuery);
		this.waitQuery = [];
	},
	genfd: function(file, noAutoBind) {
		var self = this;
		// 只要有一次genfd，那么opts的file就会被清掉
		self.opts.file = null;

		if (typeof file != 'string') {
			if (noAutoBind !== true) self.fd = file;
			self.emit('open', null, file, noAutoBind);
			return;
		}

		this._genfd.generate(file, self.opts.flag, function(err, fd) {
			if (!err && noAutoBind !== true) self.bindfd(fd); 
			self.emit('open', err, fd, noAutoBind, file);
		});
	},
	bindfd: function(fd, noAutoClose) {
		// 自动关闭之前的fd
		if (this.fd && noAutoClose !== true) fs.close(this.fd);

		this.fd = fd;
		this.init_();
	},
	destroy: function() {
		if (this._destroyed) return debug('destroy again');
		this._destroyed = true;

		if (!this.fd) return;

		// 将所有数据移动到write 队列
		this.toWriteQuery();
		var isWriteExtLog = true;
		this.emit('beforeDestroy', this._writing, function() {isWriteExtLog = false});

		if (this._writing) {
			this._writing = false;

			if (isWriteExtLog) {
				this.writeQuery.unshift([new Buffer('\n\n↓↓↓↓↓↓↓↓↓↓ [abq] process exit write, maybe repeat!!!~ ↓↓↓↓↓↓↓↓↓↓\n\n')]);
				this.writeQuery.push([new Buffer('\n\n↑↑↑↑↑↑↑↑↑↑ [abq] process exit write, maybe repeat!!!~ ↑↑↑↑↑↑↑↑↑↑\n\n')]);

			}
		}

		// 直接同步写
		this.flushSync();
		try {
			fs.closeSync(this.fd);
		} catch(e) {
			debug('close err:%o', e);
		}
		this.fd = null;
		this.removeAllListeners();
		this.emit('destroy');
	},

	_doFlush: function(isSync) {
		if (this._writing || !this.fd || !this.writeQuery.length) return;
		this._writing = true;

		// 一次性全部数据
		this[isSync ? '_flushSync' : '_flush'](Buffer.concat(this.writeQuery.length > 1 ? concat.apply([], this.writeQuery) : this.writeQuery[0]), 0, 0);
		this.emit('flushStart');
		this.writeQuery = [];
	},
	_flush: function(buffer, offset, retry) {
		var self = this;

		fs.write(this.fd, buffer, offset, buffer.length-offset, null, function(err, written, buffer) {
			self._flushcb(err, buffer, written, retry, false);
		});
	},
	_flushSync: function(buffer, offset, retry) {
		var written;
		var err;
		try {
			written = fs.writeSync(this.fd, buffer, offset, buffer.length-offset, null);
		} catch(e) {
			err = e;
		}

		this._flushcb(err, buffer, written || 0, retry, true);
	},
	// linux 必须逐个写，否则顺序有可能错乱
	// 同时也为了方便增加retry
	_flushcb: function(err, buffer, written, retry, isSync) {
		if (err) {
			debug('write err retry:%d err: %o', retry, err);
			if (retry < this.opts.maxRetry) {
				this[isSync ? '_flushSync' : '_flush'](buffer, written, ++retry);
				this.emit('retry', err, retry);
				debug('retry write');
				return;
			}
		}

		// 清理写队列
		this.writeQuery.shift();
		this._writing = false;

		if (this.writeQuery.length) {
			this._doFlush(isSync);
		} else {
			this.emit('flushEnd');
		}
	}
});


function GenFd() {
	this._fding = false;
	this.fd = this.file = null;
}

GenFd.prototype = {
	generate: function(file, flag, callback) {
		var self = this;

		if (self._fding) {
			return callback(new Error('opening'));
		} else if (file == self.file) {
			return callback(null, self.fd);
		}

		self._fding = true;
		self.file = file;

		mkdirp(path.dirname(file), function(err) {
			if (err) {
				callback(err);
				debug('mkdir err:%o', err);
				return;
			}

			fs.open(file, flag, function(err, fd) {
				self._fding = false;
				if (!err) self.fd = fd;
				callback(err, fd);
			});
		});
	}
};



var abqs = [];
function main(opts) {
	var abq = new ADQ(opts);
	var handler = abq.handler.bind(abq);
	handler.instance = abq;
	abqs.push(abq);
	debug('new abq %o, query len:%d', opts, abqs.length);

	// 销毁的时候从队列中移除
	abq.once('destroy', function() {
		var index = abqs.indexOf(abq);
		if (index != -1) {
			abqs.splice(abqs.indexOf(abq), 1);
		}

		debug('remove abqs %d, left len:%d', index, abqs.length);
	});

	return handler;
}

function bindProcess() {
	if (bindProcess._inited) return;
	bindProcess._inited = true;

	process.on('exit', function() {
		var exitlen = 0;
		var extobj = null;
		while(abqs[exitlen]) {
			if (extobj === abqs[0]) {
				exitlen++;
			} else {
				abqs[exitlen].destroy();
			}
		}
	});
}
