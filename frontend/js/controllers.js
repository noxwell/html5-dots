'use strict';

/* Controllers */

var controllers = angular.module('dots.controllers', []);
var server = 'http://localhost:8888';

controllers.controller('appCtrl', ['$scope', '$localStorage', '$location', function($scope, $localStorage, $location) {
	$scope.$storage = $localStorage.$default({
	    loggedIn: false,
	    user: {name:'', rating: ''},
	    auth: {id:'', token:''}
	});

	$(document).ajaxError(function(event, xhr) {
		if(xhr.status == 401)
		{
			$scope.$apply(function(){
				$scope.$storage.loggedIn = false;
				$location.path('/login');
			});
		}
	});

	$scope.pubsub = new Faye.Client(server + '/game');
	$scope.leaveChannel = function(channel){
		$scope.pubsub.publish(channel, {type: 'quit'});
	};
	$scope.pubsub.addExtension({
		outgoing: function(message, callback) {
		    if (message.channel.substring(0, 5) == '/meta' && message.channel != '/meta/subscribe' && message.channel != '/meta/disconnect')
		    	return callback(message);
		  	message.auth = $scope.$storage.auth;
		    callback(message);
		}
	});
	$scope.$on('$destroy', function(){
		$scope.pubsub.disconnect();
	});
}]);

controllers.controller('loginFormCtrl', ['$scope', '$location', function($scope, $location) {
	$scope.failure = false;
	$scope.login = function() {
		$.post(server + '/auth', {name: $scope.name, password: $scope.password}, function(data)	{
			$scope.$apply(function(){
				$scope.failure = false;
				$scope.$parent.$storage.user.name = $scope.name;
				$scope.$parent.$storage.auth = {id: data.id, token: data.token};
				$scope.$parent.$storage.loggedIn = true;
				$location.path('/queue');
			}, 'JSON');
		}).fail(function(){
			$scope.failure = true;
		});
	};
}]);

controllers.controller('registrationFormCtrl', ['$scope', '$location', function($scope, $location) {
	$scope.success = false;
	$scope.failure = false;
	$scope.alreadyExists = false;
	$scope.name = '';
	$scope.password = '';
	$scope.register = function(){
		if($scope.registrationForm.name.$valid && $scope.registrationForm.password.$valid)
		{
			$.post(server + '/register', {name: $scope.name, password: $scope.password}, function(data)	{
				$scope.$apply(function(){
					$scope.failure = false;
					$scope.alreadyExists = false;
					$scope.success = true;
				}, 'JSON');
			}).fail(function(){
				$scope.failure = true;
				$scope.alreadyExists = true;
			});
		}
		else
		{
			$scope.failure = true;
		}
	};
}]);

controllers.controller('waitingRoomCtrl', ['$scope', '$location', '$interval', function($scope, $location, $interval) {
	if($scope.$storage.loggedIn == false) 
		$location.path('/login');
	$scope.queue = [];
	$.get(server + '/queue', $scope.$storage.auth, function(data) { //get current queue
		$scope.$apply(function(){
			$scope.queue = data.queue;
		});
	}, 'JSON');

	$scope.updateUser = function(user)
	{
		if(user.id == $scope.$storage.auth.id)
			return;
		$scope.$apply(function(){
			for(var i = 0; i < $scope.queue.length; i++)
			{
				if($scope.queue[i].id == user.id)
				{
					$scope.queue[i] = user;
					return;
				}
			}
			$scope.queue.push(user); //add user if not exists
		});
	};
	$scope.removeUser = function(id)
	{
		if(id == $scope.$storage.auth.id)
			return;

		$scope.$apply(function(){
			for(var i = 0; i < $scope.queue.length; i++)
			{
				if($scope.queue[i].id == id)
				{
					$scope.queue.splice(i, 1);
					return;
				}
			}
		});
	};

	$scope.timeLeft = 0;
	$scope.waitingAccept = false;
	$scope.acceptingRequest = false;
	$scope.requestDetails = {name: '', rating: ''};
	$scope.requestDeclined = false;

	$scope.requestGame = function(id)
	{
		$scope.pubsub.publish('/game/queue', {type: 'request', target: id});
	};

	$scope.acceptRequest = function()
	{
		$scope.pubsub.publish('/game/queue', {type: 'accept', target: $scope.acceptingRequest});
	};

	$scope.declineRequest = function()
	{
		var init = $scope.acceptingRequest;
		var target = $scope.$storage.auth.id;
		$scope.pubsub.publish('/game/queue', {type: 'decline', init: init, target: target});
	}

	$scope.cancelRequest = function()
	{
		var init = $scope.$storage.auth.id;
		var target = $scope.waitingAccept;
		$scope.pubsub.publish('/game/queue', {type: 'decline', init: init, target: target});
	};

	$scope.onQueueMessage = function(message)
	{
		switch(message.type)
		{
			case 'heartbeat':
				$scope.updateUser({id: message.id, name: message.name, rating: message.rating});
				break;
			case 'quit':
				$scope.removeUser(message.id);
				break;
			case 'request':
				if($scope.waitingAccept || $scope.acceptingRequest)
					break;
				if(message.id == $scope.$storage.auth.id)
				{
					console.log('I wanna play game with', message.target);
					$scope.$apply(function(){
						$scope.waitingAccept = message.target;
					});
				}
				else if(message.target == $scope.$storage.auth.id)
				{
					console.log(message.id, 'wants play game with me');
					$scope.$apply(function(){
						$scope.requestDetails = message.user;
						$scope.acceptingRequest = message.id;
					});
				}
				break;
			case 'accept':
				if(message.id == $scope.$storage.auth.id)
				{
					console.log('I accepted game with', message.target);
					$scope.$apply(function(){
						$scope.acceptingRequest = false;
					});
				}
				else if(message.target == $scope.$storage.auth.id)
				{
					console.log(message.id, ' accepted my game');
					$scope.$apply(function(){
						$scope.waitingAccept = false;
					});
				}
				break;
			case 'decline':
				if(message.init == $scope.$storage.auth.id && message.target == $scope.waitingAccept || 
					message.init == $scope.acceptingRequest && message.target == $scope.$storage.auth.id )
				{
					$scope.$apply(function(){
						$scope.requestDeclined = true;
					});
				}
				break;
			case 'new_game':
				if(message.player_1 == $scope.$storage.auth.id || message.player_2 == $scope.$storage.auth.id)
				{
					$scope.$apply(function(){
						$location.path('/game/' + message.channel);
					});
				}
				break;
			default:
				console.log('Unknown message type:' + message.type);
		};
	};

	$scope.subscription = $scope.pubsub.subscribe('/game/queue', $scope.onQueueMessage);

	$scope.iamalive = function(){
		$scope.pubsub.publish('/game/queue', {type: 'heartbeat'});
	};
	$scope.heartbeat = $interval(function(){
		$scope.iamalive();
	}, 5000);
	$scope.iamalive(); //because interval executes only after some time

	$scope.$on('$destroy', function(){
		$scope.leaveChannel('/game/queue');
		$scope.subscription.cancel();
		$interval.cancel($scope.heartbeat);
	});
}]);

controllers.controller('gameScreenCtrl', ['$scope', '$location', '$routeParams', '$interval', function($scope, $location, $routeParams, $interval) {
	if($scope.$storage.loggedIn == false) 
		$location.path('/login');
	$scope.channel = $routeParams.channel;
	$scope.player = 0; //0 - spectator
	$scope.current_player = 1;
	$scope.score = [0, 0, 0];
	$scope.field = {};

	$scope.canvas = $('#field_canvas')[0].getContext('2d');
	$scope.canvasWidth = $('#field_canvas')[0].width;
	$scope.canvasHeight = $('#field_canvas')[0].height;
	$scope.offsetX = 4;
	$scope.offsetY = 4;
	$scope.ceilWidth = 21;
	$scope.ceilHeight = 21;

	$scope.requestedDraw = false;
	$scope.requestedSurrender = false;
	$scope.acceptingRequest = false;
	$scope.waitingAccept = false;
	$scope.requestDeclined = false;

	$.get(server + '/gameData', {id: $scope.$storage.auth.id, token: $scope.$storage.auth.token, channel: $scope.channel} , function(data) { //get current game
		$scope.$apply(function(){
			$scope.field = JSON.parse(data.field);
			$scope.redrawField();
			$scope.redrawZones();
			if(data.player_1 == $scope.$storage.auth.id)
				$scope.player = 1;
			else if(data.player_2 == $scope.$storage.auth.id)
				$scope.player = 2;
			$scope.current_player = data.current_player;
			$scope.score[1] = data.score_1;
			$scope.score[2] = data.score_2;
		});
	}, 'JSON');

	$scope.redrawZones = function()
	{
		for(var i = 0; i < $scope.field.zones.length; i++)
		{
			$scope.drawZone($scope.field.zones[i]);
		}
	}

	$scope.redrawField = function()
	{
		$scope.canvas.clearRect(0, 0, $scope.canvasWidth, $scope.canvasHeight);
		for(var i = 0; i < $scope.field.height; i++)
		{
			$scope.canvas.beginPath();
			$scope.canvas.moveTo(0, $scope.offsetY + i * $scope.ceilHeight);
      		$scope.canvas.lineTo($scope.canvasWidth, $scope.offsetY + i * $scope.ceilHeight);
			$scope.canvas.closePath();
			$scope.canvas.lineWidth = 2;
			$scope.canvas.strokeStyle = 'rgb(217, 210, 245)';
      		$scope.canvas.stroke();
		}
		for(var i = 0; i < $scope.field.width; i++)
		{
			$scope.canvas.beginPath();
			$scope.canvas.moveTo($scope.offsetX + i * $scope.ceilWidth, 0);
      		$scope.canvas.lineTo($scope.offsetX + i * $scope.ceilWidth, $scope.canvasHeight);
			$scope.canvas.closePath();
			$scope.canvas.lineWidth = 2;
			$scope.canvas.strokeStyle = 'rgb(217, 210, 245)';
      		$scope.canvas.stroke();
		}
		for(var i = 0; i < $scope.field.height; i++)
		{
			for(var j = 0; j < $scope.field.width; j++)
			{
				if($scope.field.color[i][j] != 0)
				{
					$scope.canvas.beginPath();
					$scope.canvas.arc($scope.offsetX + j * $scope.ceilWidth, $scope.offsetY + i * $scope.ceilHeight, 4, 0, 2 * Math.PI, false);
					$scope.canvas.fillStyle = ($scope.field.color[i][j] == 1) ? 'red' : 'blue';
					$scope.canvas.fill();
				}
			}
		}
	}

	$scope.drawZone = function(zone)
	{
		$scope.canvas.beginPath();
		$scope.canvas.moveTo($scope.offsetX + zone[0].y * $scope.ceilWidth, $scope.offsetY + zone[0].x * $scope.ceilHeight);
		for(var i = 1; i < zone.length; i++)
		{
			$scope.canvas.lineTo($scope.offsetX + zone[i].y * $scope.ceilWidth, $scope.offsetY + zone[i].x * $scope.ceilHeight); //remember, that x points at row and y points at column!!!
		}
		$scope.canvas.closePath();
		$scope.canvas.lineWidth = 2;
      	$scope.canvas.strokeStyle = ($scope.field.captured[zone[0].x][zone[0].y] == 1) ? 'red' : 'blue';
      	$scope.canvas.stroke();
      	$scope.canvas.fillStyle = 'rgba(0, 0, 0, 0.3)';
      	$scope.canvas.fill();
	};

	$scope.requestDraw = function(){
		console.log('request_d');
		$scope.pubsub.publish('/game/' + $scope.channel, {type: 'request', requestType: 'draw'});
	};

	$scope.requestSurrender = function(){
		$scope.pubsub.publish('/game/' + $scope.channel, {type: 'request', requestType: 'surrender'});
	};

	$scope.acceptRequest = function(){
		$scope.pubsub.publish('/game/' + $scope.channel, {type: 'accept', requestType: ($scope.requestedDraw ? 'draw' : 'surrender')});
	};

	$scope.declineRequest = function(){
		$scope.pubsub.publish('/game/' + $scope.channel, {type: 'decline', init: (3 - $scope.player), target: $scope.player});
	};

	$scope.cancelRequest = function(){
		$scope.pubsub.publish('/game/' + $scope.channel, {type: 'decline', init: $scope.player, target: (3 - $scope.player)});
	};

	$scope.quitGame = function(){

	};

	$scope.onGameMessage = function(message){
		switch(message.type)
		{
			case 'heartbeat':
				break;
			case 'request':
				$scope.$apply(function(){
					$scope.requestedDraw = (message.requestType == 'draw');
					$scope.requestedSurrender = (message.requestType == 'surrender');
					$scope.waitingAccept = (message.player == $scope.player);
					$scope.acceptingRequest = (message.player == (3 - $scope.player));
				});
				break;
			case 'accept':
				$scope.$apply(function(){
					$scope.requestedDraw = false;
					$scope.requestedSurrender = false;
					$scope.waitingAccept = false;
					$scope.acceptingRequest = false;
				});
				break;
			case 'decline':
				if(message.player != $scope.player)
				{
					$scope.$apply(function(){
						$scope.requestDeclined = true;
					});
				}
				break;
			case 'move':
				console.log('mov');
				$scope.$apply(function(){
					$scope.field.color[message.point.x][message.point.y] = message.player;
					$scope.current_player = ($scope.current_player == 1) ? 2 : 1;
					$scope.score = message.score;
					$scope.field.zones = message.zones;
					$scope.field.captured = message.captured;
					$scope.redrawField();
					$scope.redrawZones();
				});
				break;
			case 'gameover':
				$scope.$apply(function(){
					$location.path('/queue');
				});
				break;
			default:
				console.log('Unknown message type:' + message.type);
		};
	};
	$scope.subscription = $scope.pubsub.subscribe('/game/' + $scope.channel, $scope.onGameMessage);

	$scope.iamalive = function(){
		$scope.pubsub.publish('/game/' + $scope.channel, {type: 'heartbeat'});
	};
	$scope.heartbeat = $interval(function(){
		$scope.iamalive();
	}, 5000);
	$scope.iamalive(); //because interval executes only after some time

	$scope.canvasClick = function(event)
	{
		//console.log(event.offsetX, event.offsetY);
		$scope.doMove(Math.abs(Math.round((event.offsetY - $scope.offsetY) / $scope.ceilHeight)), Math.abs(Math.round((event.offsetX - $scope.offsetX) / $scope.ceilWidth)));
	}
	$scope.doMove = function(x, y){
		console.log(x, y);
		if($scope.current_player == $scope.player && !$scope.field.color[x][y] && !$scope.field.captured[x][y])
			$scope.pubsub.publish('/game/' + $scope.channel, {type: 'move', point: {x: x, y: y}});
	}

	$scope.$on('$destroy', function(){
		$scope.leaveChannel('/game/' + $scope.channel);
		$scope.subscription.cancel();
		$interval.cancel($scope.heartbeat);
	});
}]);