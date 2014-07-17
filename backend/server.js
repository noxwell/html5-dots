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
var ajax = 'file://';

app.use(bodyParser.urlencoded({ extended: false }));

function onAuth(request, response)
{
	var name = request.param('name');
	var password = request.param('password');
	response.setHeader('Access-Control-Allow-Origin', ajax);
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
	response.setHeader('Access-Control-Allow-Origin', ajax);
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
	response.setHeader('Access-Control-Allow-Origin', ajax);
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

function addRequest(id, type, target, message, callback)
{
	db.zscore('requests', id, function(err, reply){
		if(reply != null && reply > timestamp() - 15) //user already requested something
		{
			message.error = '406::Already exists';
		}
		else
		{
			db.zadd('requests', timestamp(), id);
			db.hmset('request:' + id, 'type', type, 'target', target);
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
	field = {width: 39, height: 32, color: [], captured: [], zones: []};
	for(var i = 0; i < field.height; i++)
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
	db.hget('request:' + player_1, 'target', function(err, reply){
		if(reply == null || reply != player_2)
		{
			message.error = '406::Not allowed';
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

function emptyArea(height, width)
{
	var area = [];
	for(var i = 0; i < height; i++)
	{
		area[i] = [];
		for(var j = 0; j < width; j++)
			area[i][j] = 0;
	}
	return area;
}

function fillArea(area, field, point, color)
{
	if(point.x < 0 || point.x >= field.height || point.y < 0 || point.y >= field.width || area[point.x][point.y] || (field.color[point.x][point.y] == color && field.captured[point.x][point.y] != (3 - color)))
		return;
	area[point.x][point.y] = 1;
	for(var i = 0; i < neighbours.length; i += 2) //we don't need corners
	{
		var x = point.x + neighbours[i].x;
		var y = point.y + neighbours[i].y;
		fillArea(area, field, {x: x, y: y}, color);
	}
}

function findCutpoints(area, timer, tin, fup, open_area, field, point, parent)
{
	area[point.x][point.y] = 1;
	tin[point.x][point.y] = fup[point.x][point.y] = ++timer.time;
	var children = 0;
	for(var i = 0; i < neighbours.length; i++)
	{
		var x = point.x + neighbours[i].x;
		var y = point.y + neighbours[i].y;
		if(x < 0 || x >= field.height || y < 0 || y >= field.width || open_area[x][y] || (x == parent.x && y == parent.y))
			continue;
		if(area[x][y])
		{
			fup[point.x][point.y] = Math.min(fup[point.x][point.y], tin[x][y]);
		}
		else
		{
			findCutpoints(area, timer, tin, fup, open_area, field, {x: x, y: y}, point);
			fup[point.x][point.y] = Math.min(fup[point.x][point.y], fup[x][y]);
			if (fup[x][y] >= tin[point.x][point.y] && parent.x != -1)
			{
				area[point.x][point.y] = 2;
			}
			children++;
		}
	}
	if(parent.x == -1 && children > 1)
		area[point.x][point.y] = 2;
}

function clearOpenArea(area, open_area, field)
{
	for(var i = 0; i < field.height; i++)
		for(var j = 0; j < field.width; j++)
			if(area[i][j])
				open_area[i][j] = 1;
}

function splitArea(used, area, areas, current, tin, fup, field, point, parent)
{
	used[point.x][point.y] = 1;
	areas[current][point.x][point.y] = 1;
	var children = 0;
	for(var i = 0; i < neighbours.length; i++)
	{
		var x = point.x + neighbours[i].x;
		var y = point.y + neighbours[i].y;
		if(x < 0 || x >= field.height || y < 0 || y >= field.width || !area[x][y] || used[x][y] || (x == parent.x && y == parent.y))
			continue;
		children++;
		if((fup[x][y] >= tin[point.x][point.y] && parent.x != -1) || (parent.x == -1 && children > 1))
		{
			var new_current = areas.length;
			areas[new_current] = emptyArea(field.height, field.width);
			areas[new_current][point.x][point.y] = 1;
			splitArea(used, area, areas, new_current, tin, fup, field, {x: x, y: y}, point);
		}
		else
		{
			splitArea(used, area, areas, current, tin, fup, field, {x: x, y: y}, point);
		}
	}
}

function findAreas(open_area, field)
{
	var areas = [];
	var current = 0;
	for(var x = 0; x < field.height; x++)
	{
		for(var y = 0; y < field.width; y++)
		{
			if(!open_area[x][y])
			{
				var area = emptyArea(field.height, field.width);
				var tin = emptyArea(field.height, field.width);
				var fup = emptyArea(field.height, field.width);
				findCutpoints(area, {time: 0}, tin, fup, open_area, field, {x: x, y: y}, {x: -1, y: -1});
				clearOpenArea(area, open_area, field);
				areas[current] = emptyArea(field.height, field.width);
				splitArea(emptyArea(field.height, field.width), area, areas, current, tin, fup, field, {x: x, y: y}, {x: -1, y: -1});
				current = areas.length;
			}
		}
	}
	return areas;
}

function borderLine(area, field)
{
	var start = null;
	for(var i = 0; i < field.height; i++)
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
	var parent = {x: -1, y: -1}
	console.log(start);
	var line = [];
	do
	{
		var i = 0;
		if(parent.x != -1)
		{
			while(true)
			{	
				var x = point.x + neighbours[i].x;
				var y = point.y + neighbours[i].y;
				if(parent.x == x && parent.y == y)
					break;
				i++;
			}
		}
		while(true)
		{
			var j = (i + 1) % neighbours.length;
			var xi = point.x + neighbours[i].x, xj = point.x + neighbours[j].x;
			var yi = point.y + neighbours[i].y, yj = point.y + neighbours[j].y;
			if((xi < 0 || xi >= field.height || yi < 0 || yi >= field.width || area[xi][yi] == 0) && (xj >= 0 && xj < field.height && yj >= 0 && yj < field.width && area[xj][yj] != 0))
			{
				parent = point;
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

function checkArea(area, field, color)
{
	var anticolor = 3 - color;
	for(var i = 0; i < field.height; i++)
	{
		for(var j = 0; j < field.width; j++)
		{
			if(area[i][j] && (field.color[i][j] == anticolor))
				return true;
		}
	}
	return false;
}

function checkLine(line, field, color)
{
	var anticolor = 3 - color;
	for(var i = 0; i < line.length; i++)
	{
		if(field.captured[line[i].x][line[i].y] == anticolor)
			return false;
	}
	return true;
}

function updateCaptured(area, field, color)
{
	for(var i = 0; i < field.height; i++)
		for(var j = 0; j < field.width; j++)
			if(area[i][j])
				field.captured[i][j] = color;
}

function findZones(message, field, color)
{
	var open_area = emptyArea(field.height, field.width);
	for(var i = 0; i < field.width; i++)
	{
		fillArea(open_area, field, {x: 0, y: i}, color);
		fillArea(open_area, field, {x: field.height - 1, y: i}, color);
	}
	for(var i = 0; i < field.height; i++)
	{
		fillArea(open_area, field, {x: i, y: 0}, color);
		fillArea(open_area, field, {x: i, y: field.width - 1}, color);
	}
	areas = findAreas(open_area, field);
	for(var i = 0; i < areas.length; i++)
		if(checkArea(areas[i], field, color))
		{
			var line = borderLine(areas[i], field);
			if(checkLine(line, field, color))
			{
				field.zones.push(borderLine(areas[i], field));
				updateCaptured(areas[i], field, color);
			}
		}
}

function updateScores(field)
{
	score = [0, 0, 0];
	for(var i = 0; i < field.height; i++)
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
	field.zones = [];
	findZones(message, field, message.data.player);
	findZones(message, field, 3 - message.data.player);
	message.data.zones = field.zones;
	message.data.captured = field.captured;
	updateScores(field);
	message.data.score = [0, field.score_1, field.score_2];
	db.hmset('game:' + game_id, 'current_player', ((message.data.player == 1) ? 2 : 1), 'field', JSON.stringify(field));
	callback(message);
}

function eloCoefficient(rating)
{
	var res = 10;
	if(rating < 2400)
		res = 15;
	if(rating < 1700)
		res = 25;
	return res;
}

function updateRatings(game, winner)
{
	db.hget('user:' + game.player_1, 'rating', function(err, rating_1){
		db.hget('user:' + game.player_2, 'rating', function(err, rating_2){
			rating_1 = Number(rating_1);
			rating_2 = Number(rating_2);
			var e1 = 1.0 / (1.0 + Math.pow(10, (rating_2 - rating_1) / 400.0));
			var e2 = 1.0 / (1.0 + Math.pow(10, (rating_1 - rating_2) / 400.0));
			var s1 = 0.5;
			var s2 = 0.5
			if(winner == 1)
			{
				var s1 = 1;
				var s2 = 0;
			}
			else if(winner == 2)
			{
				var s1 = 0;
				var s2 = 1;
			}
			var new_rating_1 = Math.round(rating_1 + eloCoefficient(rating_1) * (s1 - e1));
			var new_rating_2 = Math.round(rating_2 + eloCoefficient(rating_2) * (s2 - e2));
			db.hset('user:' + game.player_1, 'rating', new_rating_1);
			db.hset('user:' + game.player_2, 'rating', new_rating_2);
		});
	});
}

function gameOver(game_id, game, draw, message, callback)
{
	var winner;
	if(game.score_1 == game.score_2 || draw)
		winner = 0;
	else if(game.score_1 > game.score_2)
		winner = 1;
	else
		winner = 2;
	var rating = [0, 0];
	updateRatings(game, winner);
	bayeux.getClient().publish('/game/' + game.channel, {type: 'gameover', id: 0, score_1: game.score_1, score_2: game.score_2, winner: winner});
	db.hdel('games', game.channel);
	db.del('game:' + game_id);
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
			if(game == null)
			{
				message.error = '404::Game not found';
				return callback(message);
			}
			if(game.player_1 == id)
				message.data.player = 1;
			else if (game.player_2 == id)
				message.data.player = 2;
			else
				message.data.player = 0;

			var other_player = 3 - message.data.player;

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

			if(message.data.type == 'request')
			{
				if(message.data.player != 0 && (message.data.requestType == 'draw' || message.data.requestType == 'surrender'))
				{
					return addRequest(game['player_' + message.data.player], message.data.requestType, game['player_' + other_player], message, callback);
				}
			}

			if(message.data.type == 'accept')
			{
				if(message.data.player != 0)
				{
					return db.hget('request:' + game['player_' + other_player], 'target', function(err, reply){
						if(reply == null || reply != game['player_' + message.data.player])
						{
							message.error = '406::Not allowed';
							return callback(message);
						}
						gameOver(id, game, (message.data.requestType == 'draw'), message, callback);
					});
				}
			}

			if(message.data.type == 'decline')
			{
				if(message.data.player != 0)
				{
					return cancelRequest(game['player_' + message.data.init], game['player_' + message.data.target], message, callback);
				}
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
				message.data.user = {name: user.name, rating: user.rating};
				return addRequest(auth.id, 'newgame', message.data.target, message, callback);
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