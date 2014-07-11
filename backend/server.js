var http = require('http');
var express = require('express');
var bodyParser = require('body-parser');
var faye = require('faye');
var redis = require('redis');
var url = require('url');
var crypto = require('crypto')

var app = express();
var server = http.createServer(app);
var db = redis.createClient(6379, 'acm.tpu.ru');
var bayeux = new faye.NodeAdapter({mount: '/game', timeout: 45});

app.use(bodyParser.urlencoded({ extended: false }));

function onAuth(request, response)
{
	var name = request.param('name');
	var password = request.param('password');
	response.setHeader('Access-Control-Allow-Origin', 'file://');
	db.hget('users', name, function(err, id){
		if(err) throw err;
		if(id == null)
		{
			response.status(401).send('Invalid username/password');
		}
		else
		{
			db.hget('user:' + id, 'password', function(err, passwd){
				if(err) throw err;
				if(password != passwd)
				{
					response.status(401).send('Invalid username/password');
				}
				else
				{
					crypto.randomBytes(10, function(err, buf){
						var token = buf.toString('hex');
						db.hset('user:' + id, 'token', token);
						response.json({id: id, token: token});
					});
				}
			});
		}
	});
}

function checkAuth(id, token, succ, fail)
{
	db.hgetall('user:' + id, function(err, reply){
		if(err) throw err;
		if(reply != null && reply.token != '' && token == reply.token)
			succ(reply);
		else
			fail();
	});
}

function getQueue(request, response)
{
	response.setHeader('Access-Control-Allow-Origin', 'file://');
	checkAuth(request.param('id'), request.param('token'), function(){ //authorized
		db.sort('queue', 'by', 'user:*->rating', 'get', '#', 'get', 'user:*->name', 'get', 'user:*->rating', function(err, reply){
			var queue = [];
			for(i = 0; i < reply.length / 3; i++)
			{
				var ix = i * 3;
				queue[i] = {id: reply[ix], name: reply[ix + 1], rating: reply[ix + 2]};
			}
			response.json({queue: queue});
		});
	}, function(){
		response.status(401).send('Invalid token!');
	});
}

function kickPlayer(id)
{
	db.zrem('queue', id);
	bayeux.getClient().publish('/game/queue', {type: 'quit', id: id});
}

function addRequest(id, message, callback)
{
	db.zscore('requests', id, function(err, reply){
		if(reply != null && reply > timestamp() - 15) //user already requested something
		{
			message.error = '406::Already exists';
		}
		else
		{
			db.zadd('requests', timestamp(), id);
			db.hmset('request:' + id, 'type', 'newgame', 'target', message.data.target);
		}
		callback(message);
	});
}

function cancelRequest(id, target, message, callback)
{
	db.hget('request:' + id, 'target', function(err, reply){
		if(reply == null || reply != target)
		{
			message.error = '403::Authentication required';
		}
		else
		{
			db.zrem('requests', id);
			db.del('request:' + id);
		}
		callback(message);
	});
}

function createGame(player_1, player_2, message, callback)
{
	console.log('creation started');
	db.zscore('requests', player_1, function(err, reply){
		if(reply == null || reply < timestamp() - 15)
		{
			message.error = '406::Nothing to accept';
		}
		else
		{
			crypto.randomBytes(5, function(err, buf){
				var channel = buf.toString('hex');
				db.incr('last_gameid', function(err, game_id){
					db.hset('games', channel, game_id);
					db.hmset('game:' + game_id, 'channel', channel, 'field', 'empty', 'player:1', player_1, 'player:2', player_2);
					console.log('game created');
					bayeux.getClient().publish('/game/queue', {type: 'new_game', id: 0, channel: channel, player_1: player_1, player_2: player_2});
				});
			});
		}
		callback(message);
	});
}

app.post('/auth', onAuth);
app.get('/queue', getQueue);

//pub-sub engine
var server_token = 'suppasecretservertoken';
function timestamp()
{
	return Math.round(Date.now() / 1000);
}

var unauthorized_message = function(message, callback){
	return function(){
		console.log('unauth, ', message.channel);
		message.error = '403::Authentication required';
		callback(message);
	};
}

bayeux.getClient().addExtension({
	outgoing: function(message, callback) {
	    if (message.channel.substring(0, 5) == '/meta' && message.channel != '/meta/subscribe')
	    	return callback(message);
	  	message.auth = {id: 0, token: server_token};
	    callback(message);
	}
});

bayeux.addExtension({
	incoming: function(message, callback){
		if (message.channel.substring(0, 5) == '/meta' && message.channel != '/meta/subscribe' && message.channel != '/meta/disconnect')
		    return callback(message);

		var auth = message.auth;
		if(auth == null)
		{
			return unauthorized_message(message, callback)();
		}
		delete message.auth;

		if(auth.token == server_token) //message sent by server
		{
			return callback(message);
		}

		checkAuth(auth.id, auth.token, function(user){
			if(message.data != null)
				message.data.id = auth.id;
			if(message.channel == '/game/queue' && message.type == 'new_game' && auth.id != 0) //only server can send new_game messages
				return unauthorized_message(message, callback)();
			if(message.channel == '/game/queue' && message.data.type == 'heartbeat')
			{
				message.data.name = user.name;
				message.data.rating = user.rating;
				db.zadd('queue', timestamp(), auth.id);
			}

			if(message.channel == '/game/queue' && message.data.type == 'request')
			{
				message.data.name = user.name;
				message.data.rating = user.rating;
				return addRequest(auth.id, message, callback);
			}

			if(message.channel == '/game/queue' && message.data.type == 'accept')
			{
				return createGame(message.data.target, auth.id, message, callback);
			}


			if(message.channel == '/game/queue' && message.data.type == 'decline' && (auth.id == message.data.init || auth.id == message.data.target))
			{
				return cancelRequest(message.data.id, message.data.target, message, callback);
			}

			if(message.channel == '/meta/disconnect')
			{
				kickPlayer(auth.id);
			}
			callback(message);
		}, unauthorized_message(message, callback));
	}
});

function garbageCollector()
{
	//find offline users
	db.zrangebyscore('queue', '-inf', timestamp() - 10, function(err, result){
		for(i = 0; i < result.length; i++)
		{
			console.log('Player', result[i], 'quit');
			kickPlayer(result[i]);
		}
	});

	//find outdated requests
	db.zrangebyscore('requests', '-inf', timestamp() - 15, function(err, result){
		for(i = 0; i < result.length; i++)
		{
			result[i] = 'request:' + result[i];
		}
		db.del(result);
	});
	db.zremrangebyscore('requests', '-inf', timestamp() - 15);
}

setInterval(garbageCollector, 10000);

bayeux.attach(server);
server.listen(8888);