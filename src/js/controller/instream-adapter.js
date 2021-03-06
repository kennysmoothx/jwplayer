import { OS } from 'environment/environment';
import { STATE_BUFFERING, STATE_COMPLETE, STATE_PAUSED, STATE_PLAYING, ERROR, MEDIA_TIME, MEDIA_COMPLETE,
    PLAYLIST_ITEM, PLAYLIST_COMPLETE, INSTREAM_CLICK, MEDIA_META, AD_SKIPPED } from 'events/events';

define([
    'controller/instream-html5',
    'controller/instream-flash',
    'utils/helpers',
    'utils/backbone.events',
    'utils/underscore'
], function(InstreamHtml5, InstreamFlash, utils, Events, _) {

    function chooseInstreamMethod(_model) {
        var providerName = '';
        var provider = _model.get('provider');
        if (provider) {
            providerName = provider.name;
        }
        if (providerName.indexOf('flash') >= 0) {
            return InstreamFlash;
        }

        return InstreamHtml5;
    }

    var _defaultOptions = {
        skipoffset: null,
        tag: null
    };

    var InstreamAdapter = function(_controller, _model, _view) {
        var InstreamMethod = chooseInstreamMethod(_model);
        var _instream = new InstreamMethod(_controller, _model);

        var _array;
        var _arrayOptions;
        var _arrayIndex = 0;
        var _options = {};
        var _oldProvider;
        var _oldpos;
        var _olditem;
        var _this = this;

        var _clickHandler = _.bind(function(evt) {
            evt = evt || {};
            evt.hasControls = !!_model.get('controls');

            this.trigger(INSTREAM_CLICK, evt);

            // toggle playback after click event
            if (!_instream || !_instream._adModel) {
                return;
            }
            if (_instream._adModel.get('state') === STATE_PAUSED) {
                if (evt.hasControls) {
                    _instream.instreamPlay();
                }
            } else {
                _instream.instreamPause();
            }
        }, this);

        var _doubleClickHandler = _.bind(function() {
            if (!_instream || !_instream._adModel) {
                return;
            }
            if (_instream._adModel.get('state') === STATE_PAUSED) {
                if (_model.get('controls')) {
                    _controller.setFullscreen();
                    _controller.play();
                }
            }
        }, this);

        this.type = 'instream';

        this.init = function(sharedVideoTag) {
            // Keep track of the original player state
            _oldProvider = _model.getVideo();
            _oldpos = _model.get('position');
            _olditem = _model.get('playlist')[_model.get('item')];
            // Reset playback rate to 1 in case we reuse the video tag used to play back ad content
            _oldProvider.setPlaybackRate(1);

            _instream.on('all', _instreamForward, this);
            _instream.on(MEDIA_TIME, _instreamTime, this);
            _instream.on(MEDIA_COMPLETE, _instreamItemComplete, this);
            _instream.init();

            // Make sure the original player's provider stops broadcasting events (pseudo-lock...)
            _controller.detachMedia();

            _model.mediaModel.set('state', STATE_BUFFERING);

            if (_controller.checkBeforePlay() || (_oldpos === 0 && !_model.checkComplete())) {
                // make sure video restarts after preroll
                _oldpos = 0;
                _model.set('preInstreamState', 'instream-preroll');
            } else if (_oldProvider && _model.checkComplete() || _model.get('state') === STATE_COMPLETE) {
                _model.set('preInstreamState', 'instream-postroll');
            } else {
                _model.set('preInstreamState', 'instream-midroll');
            }

            // If the player's currently playing, pause the video tag
            var currState = _model.get('state');
            if (!sharedVideoTag && (currState === STATE_PLAYING || currState === STATE_BUFFERING)) {
                _oldProvider.pause();
            }

            // Show instream state instead of normal player state
            _view.setupInstream(_instream._adModel);
            _instream._adModel.set('state', STATE_BUFFERING);

            // don't trigger api play/pause on display click
            if (_view.clickHandler()) {
                _view.clickHandler().setAlternateClickHandlers(utils.noop, null);
            }

            this.setText(_model.get('localization').loadingAd);
            return this;
        };

        function _loadNextItem() {
            // We want a play event for the next item, so we ensure the state != playing
            _instream._adModel.set('state', STATE_BUFFERING);

            // destroy skip button
            _model.set('skipButton', false);

            _arrayIndex++;
            var item = _array[_arrayIndex];
            var options;
            if (_arrayOptions) {
                options = _arrayOptions[_arrayIndex];
            }
            _this.loadItem(item, options);
        }

        function _instreamForward(type, data) {
            if (type === 'complete') {
                return;
            }
            data = data || {};

            if (_options.tag && !data.tag) {
                data.tag = _options.tag;
            }

            this.trigger(type, data);

            if (type === 'mediaError' || type === 'error') {
                if (_array && _arrayIndex + 1 < _array.length) {
                    _loadNextItem();
                }
            }
        }

        function _instreamTime(evt) {
            _instream._adModel.set('duration', evt.duration);
            _instream._adModel.set('position', evt.position);
        }

        function _instreamItemComplete(e) {
            var data = {};
            if (_options.tag) {
                data.tag = _options.tag;
            }
            this.trigger(MEDIA_COMPLETE, data);
            _instreamItemNext.call(this, e);
        }

        var _instreamItemNext = function(e) {
            if (_array && _arrayIndex + 1 < _array.length) {
                _loadNextItem();
            } else {
                // notify vast of breakEnd
                this.trigger('adBreakEnd', {});
                if (e.type === MEDIA_COMPLETE) {
                    // Dispatch playlist complete event for ad pods
                    this.trigger(PLAYLIST_COMPLETE, {});
                }
                this.destroy();
            }
        };

        this.loadItem = function(item, options) {
            if (!_instream) {
                return;
            }
            if (OS.android && OS.version.major === 2 && OS.version.minor === 3) {
                this.trigger({
                    type: ERROR,
                    message: 'Error loading instream: Cannot play instream on Android 2.3'
                });
                return;
            }
            // Copy the playlist item passed in and make sure it's formatted as a proper playlist item
            var playlist = item;
            if (_.isArray(item)) {
                _array = item;
                _arrayOptions = options;
                item = _array[_arrayIndex];
                if (_arrayOptions) {
                    options = _arrayOptions[_arrayIndex];
                }
            } else {
                playlist = [item];
            }

            var providersManager = _model.getProviders();
            var providersNeeded = providersManager.required(playlist);

            _model.set('hideAdsControls', false);
            _instream._adModel.set('state', STATE_BUFFERING);
            providersManager.load(providersNeeded)
                .then(function() {
                    if (!_instream) {
                        return;
                    }
                    // Dispatch playlist item event for ad pods
                    _this.trigger(PLAYLIST_ITEM, {
                        index: _arrayIndex,
                        item: item
                    });

                    _options = _.extend({}, _defaultOptions, options);
                    _instream.load(item);

                    _this.addClickHandler();

                    var skipoffset = item.skipoffset || _options.skipoffset;
                    if (skipoffset) {
                        _this.setupSkipButton(skipoffset, _options);
                    }
                });
        };

        this.setupSkipButton = function(skipoffset, options, customNext) {
            _model.set('skipButton', false);
            if (customNext) {
                _instreamItemNext = customNext;
            }
            _instream._adModel.set('skipMessage', options.skipMessage);
            _instream._adModel.set('skipText', options.skipText);
            _instream._adModel.set('skipOffset', skipoffset);
            _model.set('skipButton', true);
        };

        this.applyProviderListeners = function(provider) {
            _instream.applyProviderListeners(provider);

            this.addClickHandler();
        };

        this.play = function() {
            _instream.instreamPlay();
        };

        this.pause = function() {
            _instream.instreamPause();
        };

        this.addClickHandler = function() {
            // start listening for ad click
            if (_view.clickHandler()) {
                _view.clickHandler().setAlternateClickHandlers(_clickHandler, _doubleClickHandler);
            }

            _instream.on(MEDIA_META, this.metaHandler, this);
        };

        this.skipAd = function(evt) {
            var skipAdType = AD_SKIPPED;
            this.trigger(skipAdType, evt);
            _instreamItemNext.call(this, {
                type: skipAdType
            });
        };

        /** Handle the MEDIA_META event **/
        this.metaHandler = function (evt) {
            // If we're getting video dimension metadata from the provider, allow the view to resize the media
            if (evt.width && evt.height) {
                _view.resizeMedia();
            }
        };

        this.destroy = function() {
            this.off();

            _model.set('skipButton', false);

            if (_instream) {
                if (_view.clickHandler()) {
                    _view.clickHandler().revertAlternateClickHandlers();
                }

                _model.off(null, null, _instream);
                _instream.off(null, null, _this);
                _instream.instreamDestroy();

                // Must happen after instream.instreamDestroy()
                _view.destroyInstream();

                _instream = null;

                // Player was destroyed
                if (_model.attributes._destroyed) {
                    return;
                }

                // Re-attach the controller
                _controller.attachMedia();

                var oldMode = _model.get('preInstreamState');
                switch (oldMode) {
                    case 'instream-preroll':
                    case 'instream-midroll':
                        var item = _.extend({}, _olditem);
                        item.starttime = _oldpos;
                        _model.loadVideo(item);

                        // On error, mediaModel has buffering states in mobile, but oldProvider's state is playing.
                        // So, changing mediaModel's state to playing does not change provider state unless we do this
                        if (OS.mobile && (_model.mediaModel.get('state') === STATE_BUFFERING)) {
                            _oldProvider.setState(STATE_BUFFERING);
                        }
                        _oldProvider.play();
                        break;
                    case 'instream-postroll':
                    case 'instream-idle':
                        _oldProvider.stop();
                        break;
                    default:
                        break;
                }
            }
        };

        this.getState = function() {
            if (_instream && _instream._adModel) {
                return _instream._adModel.get('state');
            }
            // api expects false to know we aren't in instreamMode
            return false;
        };

        this.setText = function(text) {
            _view.setAltText(text ? text : '');
        };

        // This method is triggered by plugins which want to hide player controls
        this.hide = function() {
            _model.set('hideAdsControls', true);
        };

    };

    _.extend(InstreamAdapter.prototype, Events);

    return InstreamAdapter;
});
