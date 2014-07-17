'use strict';


// Declare app level module which depends on filters, and services
var app = angular.module('dots', [
	'ngRoute',
	'ngStorage',
	'dots.controllers',
	'dots.directives'
]);

app.config(function($routeProvider) {
	$routeProvider.
	when("/login",  {templateUrl:'partials/login.html',  controller:'loginFormCtrl'}).
	when("/register",  {templateUrl:'partials/register.html',  controller:'registrationFormCtrl'}).
	when("/queue",  {templateUrl:'partials/queue.html',  controller:'waitingRoomCtrl'}).
	when("/game/:channel",  {templateUrl:'partials/game.html',  controller:'gameScreenCtrl'}).
	otherwise({redirectTo: '/login'});
});