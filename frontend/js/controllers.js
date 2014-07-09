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

controllers.controller('waitingRoomCtrl', ['$scope', '$location', function($scope, $location) {
	if($scope.$storage.loggedIn == false) 
		$location.path('/login');
	$scope.queue = [];
	$.get(server + '/queue', $scope.$storage.auth, function(data) {
		$scope.$apply(function(){
			$scope.queue = data.queue;
		});
	}, 'JSON');
	/*$scope.lastMessage = "no message";
	$scope.client = new Faye.Client('http://localhost:8888/game');
	$scope.onMessage = function(message)
	{
		$scope.$apply(function()
		{
			$scope.lastMessage = message.text;
		});
	};
	$scope.subscription = $scope.client.subscribe('/game/echo', $scope.onMessage);*/
}]);

controllers.controller('gameScreenCtrl', ['$scope', '$location', function($scope, $location) {
	
}]);