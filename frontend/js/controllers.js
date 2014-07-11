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

	$scope.pubsub = new Faye.Client('http://localhost:8888/game');
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
	$scope.login = function() {
		$.post(server + '/auth', {name: $scope.name, password: $scope.password}, function(data)	{
			$scope.$apply(function(){
				$scope.$parent.$storage.user.name = $scope.name;
				$scope.$parent.$storage.auth = {id: data.id, token: data.token};
				$scope.$parent.$storage.loggedIn = true;
				$location.path('/queue');
			}, 'JSON');
		});
	};
}]);

controllers.controller('registrationFormCtrl', ['$scope', '$location', function($scope, $location) {
	
}]);

controllers.controller('waitingRoomCtrl', ['$scope', '$location', '$interval', function($scope, $location, $interval) {
	if($scope.$storage.loggedIn == false) 
		$location.path('/login');
	$scope.queue = [];
	$.get(server + '/queue', $scope.$storage.auth, function(data) { //get cuurrent queue
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
	$scope.requestDeclined = function(timeout){
		timeout = (typeof timeout !== 'undefined') ?  timeout : true;
		if($scope.waitingAccept)
		{
			console.log(timeout ? 'request timeout' : 'request cancelled');
			$scope.waitingAccept = false;
		}
		else if($scope.acceptingRequest)
		{
			console.log(timeout ? 'answer timeout' : 'request cancelled');
			$scope.acceptingRequest = false;
		}
	};

	$scope.countdown = null;
	$scope.startCountdown = function(time, timeout){
		$scope.$apply(function(){
			$scope.timeLeft = time;
		});
		$scope.countdown = $interval(function(){
			$scope.timeLeft--;
			if($scope.timeLeft == 0)
				timeout();
		}, 1000, time, true);
	};
	$scope.stopCountdown = function(){
		$scope.$apply(function(){
			$scope.timeLeft = 0;
			$interval.cancel($scope.countdown);
		});
	};

	$scope.requestGame = function(id)
	{
		$scope.pubsub.publish('/game/queue', {type: 'request', target: id});
	};

	$scope.acceptGame = function()
	{
		$scope.pubsub.publish('/game/queue', {type: 'accept', target: $scope.acceptingRequest});
	};

	$scope.cancelRequest = function()
	{
		if($scope.waitingAccept)
		{
			var init = $scope.$storage.auth.id;
			var target = $scope.waitingAccept;
		}
		else if($scope.acceptingRequest)
		{
			var init = $scope.acceptingRequest;
			var target = $scope.$storage.auth.id;
		}
		else
		{
			return;
		}
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
					$scope.waitingAccept = message.target;
					$scope.startCountdown(15, $scope.requestDeclined);
				}
				else if(message.target == $scope.$storage.auth.id)
				{
					console.log(message.id, 'wants play game with me');
					$scope.acceptingRequest = message.id;
					$scope.startCountdown(15, $scope.requestDeclined);
				}
				break;
			case 'accept':
				if(message.id == $scope.$storage.auth.id)
				{
					console.log('I accepted game with', message.target);
					$scope.acceptingRequest = false;
					$scope.stopCountdown();
				}
				else if(message.target == $scope.$storage.auth.id)
				{
					console.log(message.id, ' accepted my game');
					$scope.waitingAccept = false;
					$scope.stopCountdown();
				}
				break;
			case 'decline':
				if(message.init == $scope.$storage.auth.id && message.target == $scope.waitingAccept || 
					message.init == $scope.acceptingRequest && message.target == $scope.$storage.auth.id )
				{
					$scope.requestDeclined(false); //it is not timeout
					$scope.stopCountdown();
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
		}
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
		if($scope.countdown != null)
			$interval.cancel($scope.countdown);
		$interval.cancel($scope.heartbeat);
	});
}]);

controllers.controller('gameScreenCtrl', ['$scope', '$location', '$routeParams', '$interval', function($scope, $location, $routeParams, $interval) {
	$scope.channel = $routeParams.channel;
	$scope.player = 0; //0 - spectator
	$scope.current_player = 1;
	$scope.field = {width: 39, heigth: 32, color: [], active: [], connect: []};
	for(var i = 0; i < $scope.field.heigth; i++)
	{
		$scope.field.color[i] = [];
		$scope.field.active[i] = [];
		for(var j = 0; j < $scope.field.width; j++)
		{
			$scope.field.color[i][j] = 0;
			$scope.field.active[i][j] = 1;
		}
	}
	$scope.onGameMessage = function(message){
		switch(message.type)
		{
			case 'heartbeat':
				if(message.id == $scope.$storage.auth.id)
					$scope.player = message.player;
				break;
			case 'request':
				break;
			case 'move':
				console.log('mov');
				$scope.$apply(function(){
					$scope.field.color[message.x][message.y] = message.player;
					$scope.current_player = ($scope.current_player == 1) ? 2 : 1;
				});
				break;
			case 'zone':
				break;
			case 'gameover':
				break;
			default:
				console.log('Unknown message type:' + message.type);
		}
	};
	$scope.subscription = $scope.pubsub.subscribe('/game/' + $scope.channel, $scope.onGameMessage);

	$scope.iamalive = function(){
		$scope.pubsub.publish('/game/' + $scope.channel, {type: 'heartbeat'});
	};
	$scope.heartbeat = $interval(function(){
		$scope.iamalive();
	}, 5000);
	$scope.iamalive(); //because interval executes only after some time

	$scope.doMove = function(x, y){
		//console.log(x, y);
		if($scope.current_player == $scope.player && $scope.field.active[x][y])
			$scope.pubsub.publish('/game/' + $scope.channel, {type: 'move', x: x, y: y});
	}

}]);