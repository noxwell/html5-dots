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

function checkAuth(auth, succ, fail)
{
	db.hgetall('user:' + auth.id, function(err, reply){
		if(err) throw err;
		if(reply != null && reply.token != '' && auth.token == reply.token)
			succ(reply);
		else
			fail();
	});
}

function getQueue(request, response)
{
	response.setHeader('Access-Control-Allow-Origin', 'file://');
	var auth = {id: request.param('id'), token: request.param('token')}
	checkAuth(auth, function(){ //authorized
		db.sort('queue', 'by', 'user:*->rating', 'get', '#', 'get', 'user:*->name', 'get', 'user:*->rating', function(err, reply){
			var queue = [];
			for(i = 0; i < reply.length / 3; i++)
			{
				var ix = i * 3;
				if(reply[ix] != auth.id) 
					queue.push({id: reply[ix], name: reply[ix + 1], rating: reply[ix + 2]});
			}
			response.json({queue: queue});
		});
	}, function(){
		response.status(401).send('Invalid token!');
	});
}

function getGameData(request, response)
{
	response.setHeader('Access-Control-Allow-Origin', 'file://');
	var auth = {id: request.param('id'), token: request.param('token')};
	checkAuth(auth, function(){
		var channel = request.param('channel');
		if(channel == null)
		{
			return response.status(400).send('Bad request');
		}
		db.hget('games', channel, function(err, game_id){
			if(game_id == null)
			{
				return response.status(404).send('Game not found');
			}
			db.hgetall('game:' + game_id, function(err, game){
				return response.json(game);
			});
		});
	}, function(){
		return response.status(401).send('Invalid token!');
	});
}

function kickPlayer(id)
{
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

function emptyField()
{
	field = {width: 39, heigth: 32, color: [], captured: [], zones: []};
	for(var i = 0; i < field.heigth; i++)
	{
		field.color[i] = [];
		field.captured[i] = [];
		for(var j = 0; j < field.width; j++)
		{
			field.color[i][j] = 0;
			field.captured[i][j] = 0;
		}
	}
	return JSON.stringify(field);
}

function createGame(player_1, player_2, message, callback)
{
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
					db.hmset('game:' + game_id, 'channel', channel, 'field', emptyField(), 'player_1', player_1, 'score_1', 0, 'player_2', player_2, 'score_2', 0, 'current_player', 1);
					bayeux.getClient().publish('/game/queue', {type: 'new_game', id: 0, channel: channel, player_1: player_1, player_2: player_2});
				});
			});
		}
		callback(message);
	});
}

var neighbours = [{x: 0, y: -1}, {x: -1, y: -1}, {x: -1, y: 0}, {x: -1, y: 1}, {x: 0, y: 1}, {x: 1, y: 1}, {x: 1, y: 0}, {x: 1, y: -1}];

function emptyArea(heigth, width)
{
	var area = [];
	for(var i = 0; i < heigth; i++)
	{
		area[i] = [];
		for(var j = 0; j < width; j++)
			area[i][j] = 0;
	}
	return area;
}

function fillArea(area, field, point, color)
{
	area[point.x][point.y] = 1;
	for(var i = 0; i < neighbours.length; i += 2) //we don't need corners
	{
		var x = point.x + neighbours[i].x;
		var y = point.y + neighbours[i].y;
		if(x >= 0 && x < field.heigth && y >= 0 && y < field.width && !area[x][y] && field.color[x][y] != color)
			area = fillArea(area, field, {x: x, y: y}, color);
	}
	return area;
}

function isAreaOpen(area, heigth, width)
{
	var open = false;
	for(var i = 0; i < width; i++)
	{
		open |= area[0][i] | area[heigth - 1][i];
	}
	for(var i = 0; i < heigth; i++)
		open |= area[i][0] | area[i][width - 1];
	return open;
}

function borderLine(area, field, color)
{
	for(var i = 0; i < field.heigth; i++)
	{
		for(var j = 0; j < field.width; j++)
		{
			if(area[i][j] != 1)
				continue;
			for(var k = 0; k < neighbours.length; k++)
			{
				var x = i + neighbours[k].x;
				var y = j + neighbours[k].y;
				if(x >= 0 && x < field.heigth && y >= 0 && y < field.width && field.color[x][y] == color)
					area[x][y] = 2;
			}
		}
	}
	var start = null;
	for(var i = 0; i < field.heigth; i++)
	{
		for(var j = 0; j < field.width; j++)
		{
			if(area[i][j])
			{
				start = {x: i, y: j};
				break;
			}
		}
		if(start != null)
			break;
	}
	var point = start;
	console.log(start);
	var line = [];
	do
	{
		var i = 0;
		while(true)
		{
			var j = (i + 1) % neighbours.length;
			var xi = point.x + neighbours[i].x, xj = point.x + neighbours[j].x;
			var yi = point.y + neighbours[i].y, yj = point.y + neighbours[j].y;
			if((xi < 0 || xi >= field.heigth || yi < 0 || yi >= field.width || area[xi][yi] == 0) && (xj >= 0 && xj < field.heigth && yj >= 0 && yj < field.width && area[xj][yj] != 0))
			{
				point = {x: xj, y: yj};
				break;
			}
			i = j;
		}
		console.log(point);
		line.push(point);
	} while(point.x != start.x || point.y != start.y);
	return line;
}

function updateCaptured(line, field, color)
{
	var area = emptyArea(field.heigth, field.width);
	for(var i = 0; i < line.length; i++)
		area[line[i].x][line[i].y] = 3; //border color
	for(var i = 0; i < field.heigth; i++)
	{
		var capture = 0;
		for(var j = 0; j < field.width; j++)
		{
			if(area[i][j] != 3)
				area[i][j] = capture;
			else
				capture = color;
		}
		for(var j = field.width - 1; j >= 0; j--)
		{
			if(area[i][j] != 3)
				area[i][j] = 0;
			else
				break;
		}
	}
	for(var i = 0; i < field.heigth; i++)
	{
		for(var j = 0; j < field.width; j++)
		{
			if(area[i][j] == color || area[i][j] == 3)
				field.captured[i][j] = color;
		}
	}
}

function updateScores(field)
{
	score = [0, 0, 0];
	for(var i = 0; i < field.heigth; i++)
	{
		for(var j = 0; j < field.width; j++)
		{
			if(field.color[i][j] != 0 && field.captured[i][j] != 0 && field.captured[i][j] != field.color[i][j])
			{
				score[field.captured[i][j]]++;
			}
		}
	}
	field.score_1 = score[1];
	field.score_2 = score[2];
}

function findZones(message, field, point)
{
	for(var i = 0; i < neighbours.length; i++)
	{
		var x = point.x + neighbours[i].x;
		var y = point.y + neighbours[i].y;
		var color = field.color[point.x][point.y];
		if(x >= 0 && x < field.heigth && y >= 0 && y < field.width && field.color[x][y] != color && !field.captured[x][y])
		{
			var area = fillArea(emptyArea(field.heigth, field.width), field, {x: x, y: y}, color);
			console.log('test');
			if(!isAreaOpen(area, field.heigth, field.width))
			{
				console.log('open');
				var line = borderLine(area, field, color);
				updateCaptured(line, field, color);
				field.zones.push(line);
				bayeux.getClient().publish(message.channel, {type: 'zone', id: message.data.id, zone: line});
			}
		}
	}
}

function doMove(message, callback, game_id, field, point)
{
	if(typeof point === 'undefined' || typeof point.x === 'undefined' || typeof point.y === 'undefined')
	{
		message.error = '400::Bad request';
		return callback(message);
	}
	if(field.color[point.x][point.y] != 0 || field.captured[point.x][point.y] != 0)
	{
		message.error = '406::Point is busy';
		return callback(message);
	}
	field.color[point.x][point.y] = message.data.player;
	console.log(field.color[point.x][point.y]);
	findZones(message, field, point);
	updateScores(field);
	message.data.score = [0, field.score_1, field.score_2];
	db.hmset('game:' + game_id, 'current_player', ((message.data.player == 1) ? 2 : 1), 'field', JSON.stringify(field));
	callback(message);
}

function gameChannel(channel, id, message, callback)
{
	db.hget('games', channel, function(err, game_id){
		if(game_id == null)
		{
			message.error = '404::Game not found';
			callback(message);
		}
		db.hgetall('game:' + game_id, function(err, game){
			if(game.player_1 == id)
				message.data.player = 1;
			else if (game.player_2 == id)
				message.data.player = 2;
			else
				message.data.player = 0;

			game.field = JSON.parse(game.field);

			if(message.data.type == 'heartbeat' && message.data.player != 0)
			{
				db.hset('game', 'timestamp_' + message.data.player, timestamp());
			}

			if(message.data.type == 'move')
			{
				if(message.data.player != game.current_player)
					message.error = '406::Not allowed';
				else
					return doMove(message, callback, game_id, game.field, message.data.point);
			}

			callback(message);
		});
	});
}

app.post('/auth', onAuth);
app.get('/queue', getQueue);
app.get('/gameData', getGameData);

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

		checkAuth(auth, function(user){
			if(message.data != null)
				message.data.id = auth.id;

			var game_channel = /\/game\/([a-f0-9]+)$/.exec(message.channel);
			if(game_channel != null && typeof game_channel[1] !== 'undefined')
				return gameChannel(game_channel[1], auth.id, message, callback);

			if(message.channel == '/game/queue' && message.type == 'new_game' && auth.id != 0) //only server can send new_game messages
				return unauthorized_message(message, callback)();
			if(message.channel == '/game/queue' && message.data.type == 'heartbeat')
			{
				message.data.name = user.name;
				message.data.rating = user.rating;
				db.zadd('queue', timestamp(), auth.id);
			}

			if(message.channel == '/game/queue' && message.data.type == 'quit')
			{
				console.log('Player', auth.id, 'quit');
				db.zrem('queue', auth.id);
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
				return cancelRequest(message.data.init, message.data.target, message, callback);
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
		if(result == null)
			return;
		for(i = 0; i < result.length; i++)
		{
			kickPlayer(result[i]);
		}
	});

	//find outdated requests
	db.zrangebyscore('requests', '-inf', timestamp() - 15, function(err, result){
		if(result == null)
			return;
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