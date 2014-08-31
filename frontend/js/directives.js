'use strict';

/* Directives */

angular.module('dots.directives', []).
	directive('countdown', ['$timeout', '$interval', function($timeout, $interval) {
		return {
		    restrict: 'E',
			templateUrl: 'partials/countdown.html',
			scope: {
				ngShow: '=',
				time: '@',
				onAccept: '&',
				onDecline: '&',
				onCancel: '&',
				isFailure: '=',
				failureMessage: '@',
				timeout: '@'
			},
			transclude: true,
			link: function link($scope, element, attrs) {
				$scope.canAccept = (typeof attrs.onAccept !== 'undefined');
				$scope.timeLeft = 0;
				$scope.error = '';
				$scope.showError = function(message)
				{
					$scope.stopCountdown();
					$scope.error = message;
					$timeout(function(){
						$scope.isFailure = false;
						$scope.ngShow = false;
					}, 1000, true);
				};
				$scope.accept = function() {
					$scope.onAccept();
					$scope.ngShow = false;
				};
				$scope.decline = function() {
					$scope.onDecline();
					$scope.ngShow = false;
				};
				$scope.cancel = function() {
					$scope.onCancel();
					$scope.ngShow = false;
				};
				$scope.onFailure = function() {
					if($scope.ngShow != false && $scope.isFailure != false)
						$scope.showError($scope.failureMessage);
				};
				$scope.onTimeout = function() {
					$scope.showError($scope.timeout);
				};
				$scope.countdown = false;

				$scope.startCountdown = function(){
					$scope.timeLeft = $scope.time;
					$scope.countdown = $interval(function(){
						$scope.timeLeft--;
						if($scope.timeLeft == 0)
							$scope.onTimeout();
					}, 1000, $scope.time, true);
				};
				$scope.stopCountdown = function(){
					if($scope.timeLeft == 0)
						return;
					$scope.timeLeft = 0;
					$interval.cancel($scope.countdown);
				};
				$scope.$watch('ngShow', function(){
					if($scope.ngShow)
						$scope.startCountdown();
					else
						$scope.stopCountdown();
				});
				$scope.$watch('isFailure', $scope.onFailure);
				$scope.$on('$destroy', function(){
					if($scope.countdown)
						$interval.cancel($scope.countdown);
				});
			}
		}
	}]);