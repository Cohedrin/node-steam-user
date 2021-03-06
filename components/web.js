var SteamUser = require('../index.js');
var SteamID = require('steamid');
var Crypto = require('crypto');
var SteamCrypto = require('@doctormckay/steam-crypto');
var URL = require('url');
var HTTP = require('http');
var HTTPS = require('https');
var TLS = require('tls');
var VDF = require('vdf');

SteamUser.prototype.webLogOn = function() {
	// Verify logged on
	if (!this.steamID) {
		throw new Error("Cannot log onto steamcommunity.com without first being connected to Steam network");
	}

	// Verify not anonymous user
	if (this.steamID.type != SteamID.Type.INDIVIDUAL) {
		throw new Error('Must not be anonymous user to use webLogOn (check to see you passed in valid credentials to logOn)')
	}

	this._send(SteamUser.EMsg.ClientRequestWebAPIAuthenticateUserNonce, {});
};

SteamUser.prototype._webLogOn = function() {
	// Identical to webLogOn, except silently fails if not logged on
	if (!this.steamID || this.steamID.type != SteamID.Type.INDIVIDUAL) {
		return;
	}

	this.webLogOn();
};

SteamUser.prototype._webAuthenticate = function(nonce) {
	var sessionKey = SteamCrypto.generateSessionKey();

	// Encrypt the nonce
	var iv = Crypto.randomBytes(16);
	var aesIv = Crypto.createCipheriv('aes-256-ecb', sessionKey.plain, '');
	aesIv.setAutoPadding(false);
	aesIv.end(iv);

	var cipher = Crypto.createCipheriv('aes-256-cbc', sessionKey.plain, iv);
	cipher.end(nonce);
	var encryptedNonce = Buffer.concat([aesIv.read(), cipher.read()]);

	var data = "format=vdf&steamid=" + this.steamID.toString() +
		"&sessionkey=" + sessionKey.encrypted.toString('hex').replace(/../g, '%$&') +
		"&encrypted_loginkey=" + encryptedNonce.toString('hex').replace(/../g, '%$&');

	var options = {
		"hostname": "api.steampowered.com",
		"path": "/ISteamUserAuth/AuthenticateUser/v0001/",
		"method": "POST",
		"headers": {
			"Content-Type": "application/x-www-form-urlencoded",
			"Content-Length": data.length,
			"Accept": "text/html,*/*;q=0.9",
			"Accept-Encoding": "gzip,identity,*;q=0",
			"Accept-Charset": "ISO-8859-1,utf-8,*;q=0.7",
			"User-Agent": "Valve/Steam HTTP Client 1.0"
		}
	};

	if (this.client.localAddress || this.client._localAddress) {
		options.localAddress = this.client.localAddress || this.client._localAddress;
	}

	if (this.client.httpProxy || this.client._httpProxy) {
		options.agent = getProxyAgent(this.client.httpProxy || this.client._httpProxy);
	}

	var self = this;

	// Unsure if this is the issue, but it appears that Steam is currently rejecting valid nonces.
	// Could be a communication delay between Steam servers, so let's try adding a delay on our end to see if that helps.
	// The client does have a delay between when a nonce is received and when it tries to auth (could be coincidential?)

	var reqDelay = Math.min(this._webauthTimeout || 0, 10000); // 10 seconds max delay

	setTimeout(function() {
		var req = HTTPS.request(options, function(res) {
			var failed = false;

			if (res.statusCode != 200) {
				failed = true;
				self.emit('debug', 'Error in AuthenticateUser: ' + res.statusCode);
				fail();
			}

			var responseData = "";

			var stream = res;
			if (res.headers['content-encoding'] == 'gzip') {
				stream = require('zlib').createGunzip();
				res.pipe(stream);
			}

			stream.on('data', function(data) {
				responseData += data;
			});

			stream.on('end', function() {
				if (failed) {
					self.emit('debugAuthenticateUser', responseData);
					return;
				}

				try {
					var response = VDF.parse(responseData);
				} catch (ex) {
					fail();
					return;
				}

				delete self._webauthTimeout;

				// Generate a random sessionid (CSRF token)
				var sessionid = require('crypto').randomBytes(12).toString('hex');
				self.emit('webSession', sessionid, [
					'sessionid=' + sessionid,
					'steamLogin=' + response.authenticateuser.token,
					'steamLoginSecure=' + response.authenticateuser.tokensecure
				]);
			});
		});

		req.on('error', function(err) {
			self.emit('debug', 'Error in AuthenticateUser: ' + err.message);
			fail();
		});

		req.end(data);
	}, reqDelay);

	function fail() {
		if (self._webauthTimeout) {
			self._webauthTimeout = Math.min(self._webauthTimeout * 2, 50000);
		} else {
			self._webauthTimeout = 1000;
		}

		setTimeout(self._webLogOn.bind(self), self._webauthTimeout);
	}
};

// Handlers

SteamUser.prototype._handlers[SteamUser.EMsg.ClientRequestWebAPIAuthenticateUserNonceResponse] = function(body) {
	if(body.eresult != SteamUser.EResult.OK) {
		this.emit('debug', 'Got response ' + body.eresult + ' from ClientRequestWebAPIAuthenticateUserNonceResponse, retrying');
		setTimeout(this._webLogOn.bind(this), 500);
	} else {
		this._webAuthenticate(body.webapi_authenticate_user_nonce);
	}
};

function getProxyAgent(proxyUrl) {
	var agent = new HTTPS.Agent({"keepAlive": false});

	agent.createConnection = function(options, callback) {
		var url = URL.parse(proxyUrl);
		url.method = 'CONNECT';
		url.path = options.host + ':' + options.port;
		url.localAddress = options.localAddress;
		url.localPort = options.localPort;

		if (url.auth) {
			url.headers = {"Proxy-Authorization": "Basic " + (new Buffer(url.auth, 'utf8')).toString('base64')};
			delete url.auth;
		}

		var finished = false;
		var req = HTTP.request(url);
		req.end();
		req.setTimeout(2000);

		req.on('connect', function(res, socket, head) {
			if (finished) {
				socket.end();
				return;
			}

			finished = true;
			req.setTimeout(0);

			if (res.statusCode != 200) {
				callback(new Error("HTTP CONNECT " + res.statusCode + " " + res.statusMessage));
				return;
			}

			// Upgrade this connection to TLS
			var tlsSocket = TLS.connect({
				"socket": socket,
				"servername": options.host
			}, function() {
				if (!tlsSocket.authorized) {
					callback(new Error(tlsSocket.authorizationError || "Secure connection failed"));
					return;
				}

				callback(null, tlsSocket);
			});
		});

		req.on('timeout', function() {
			if (finished) {
				return;
			}

			finished = true;
			callback(new Error("Proxy connection timed out"));
		});

		req.on('error', function(err) {
			if (finished) {
				return;
			}

			finished = true;
			callback(err);
		});
	};

	return agent;
}
