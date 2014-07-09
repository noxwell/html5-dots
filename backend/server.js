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
	db.hget('user:' + id, 'token', function(err, reply){
		if(err) throw err;
		if(token == reply)
			succ();
		else
			fail();
	});
}

function getQueue(request, response)
{
	response.setHeader('Access-Control-Allow-Origin', 'file://');
	checkAuth(request.param('id'), request.param('token'), function(){ //authorized
		response.json({queue: [
			{id: '2', name: 'test1', rating: '100500'}, 
			{id: '3', name: 'test2', rating: '1111'}
		]});
	}, function(){ //failure
		response.status(401).send('Invalid token!');
	});
}

app.post('/auth', onAuth);
app.get('/queue', getQueue);

bayeux.attach(server);
server.listen(8888);

var msgs = ['hi', 'hey', 'hay', 'hello, world!'];
var cur = 0;

/*setInterval(function(){
	bayeux.getClient().publish('/game/echo', {text: msgs[cur]}).then(function(){
		console.log("Message published: " + msgs[cur]);
		cur = (cur + 1) % msgs.length;
	});	
}, 2000);*/