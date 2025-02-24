/*globals process*/

var http = require('http'), 
    url = require('url'),
    fs = require('fs'),
    sys = require('sys');

var querystring = require('querystring'), // for session key parsing
    Session = require('./Session').Session,
    //SocketListener = require('./SocketListener').SocketListener,
    SocketIO = require('./SocketIO').SocketIO,
    Policies = require('./Policies').Policies,
    MemStore = require('./MemStore').MemStore,
    DiskStore = require('./DiskStore').DiskStore,
    Constants = require('./Constants'),
    API = require('./API'),
    httpResponses = require('./mixins/http_responses').httpResponses,
		StoreActionCreators = require('./mixins/store_actions').StoreActionCreators,
    Tools = require('./Tools'),
    RPCHooks = require('./RPCHooks');

/*
The idea behind this Node.js ThothServer is to have a node-js server
that is reached using a apache proxy to overcome same-origin-policy trouble

The way requests are handled is more or less the same as a normal REST interface,
that is that the websocket connection uses a format that is comparable to the http requests:

{"get":"model/id"}
{"post":"model"}
{"put":"model/id"}
{"delete":"model/id"}


*/
exports.Server = SC.Object.extend(httpResponses,StoreActionCreators,{

	port: 8080,

	REPL: NO,
	
	isProfiling: false,

	RESTOnly: false,

	URLPrefix: null,  // what prefix to expect to REST requests, for example /REST, very useful when Thoth is behind a proxy

	allowXHRPolling: true,

	forceAuthentication: true, 

	forceMD5Auth: false,

	authModule: null,

	policyModule: null,

	sessionModule: null, 

	rpcModule: null, 

	store: null, // place to bind the store / data source to

	tempStore: null, // place to bind the temporary store type to, defaults to memstore, inited when the server is started

	debug: false, // show debug messages

	// ==============================
	// = Init and startup functions =
	// ==============================

	socketIO: null,

	server: null,

	_startServer: function(){
		this.server = http.createServer(this.createHTTPHandler(this));
		this.server.listen(this.port);
		sys.puts("Listening on port " + this.port);
	},
   
	init: function(){
		arguments.callee.base.apply(this, arguments); // have super called afterwards to be able to override the default URLPrefix
		if(!this.URLPrefix) this.URLPrefix = '/thoth'; // setting a default value when an instance is made
	},

	_catchException: function(err){
		sys.log('ThothServer: Caught an exception which was not caught elsewhere: ' + err);
		sys.log('stack trace: ' + err.stack);
	},

	start: function(){
		sys.puts('Starting ThothServer');
		SC.RunLoop.begin();
		if(!this.store) throw Error("No store module defined");
		
		// set up temporary store if not setup in config
		if(!this.tempStore) this.tempStore = MemStore.create();
		// set up session Module if not set up in config
		if(!this.sessionModule) this.sessionModule = Session.create();

		// start the server
		this._startServer();

		// allow stores to setup running conditions
		if(this.tempStore.start) this.tempStore.start(); 
		if(this.store.start) this.store.start(); 

		if(!this.RESTOnly){
			this._attachSocketListener();
		}
		if(this.REPL){
			this._repl = require('repl');
			this._repl.start().context.myServer = this;
		}
		if(!this.debug){
			process.on('uncaughtException', this._catchException);
		}  
		if(this.isProfiling){
		  this._profiler = require('v8-profiler');
		}
		SC.RunLoop.end();
	},
   
	_attachSocketListener: function(){
		var json = JSON.stringify;
		var me = this;
		//sys.puts("server before socketio init: " + this.server);
		// first create because we need to able to refer to it later, as start() doesn't return the object
				
		this.socketIO  = SocketIO.create({
		  ThothServer: this
		});
		
		this.socketIO.on('fetch',me.onFetch);
		this.socketIO.on('refreshRecord', me.onRefresh);
		this.socketIO.on('createRecord', me.onCreate);
		this.socketIO.on('updateRecord', me.onUpdate);
		this.socketIO.on('deleteRecord', me.onDelete);
		this.socketIO.on('rpcRequest', me.onRPCRequest);
		this.socketIO.on('logOut', me.onLogout);
		
		this.socketIO.start(this.server);
		
	},   

	createHTTPHandler: function(serverObj){
	  
    // the order of the function names is the order of execution
		var handlerFunctions = [ 
		  'handleRoot',
		  'handleRPCGET',
		  'handleStatusGET',
		  'handleAUTHRequest',
		  'handleSession'];

		var handlers = {
			handleRoot: function(path,method,request,response,callback){
				var msg;
				if(path === '/'){
					if(serverObj.debug){
						msg = "request URL: " + request.url + "<br>\n request path: " + path + "<br>";
						serverObj.send200(response,msg);
					}
					else serverObj.send404(response);
					callback('handleRoot', true);
				}
				else callback('handleRoot', false); 
			},

			handleAUTHRequest: function(path,method,request,response,callback){
				if(serverObj.forceAuthentication && (method === 'POST') && (path.slice(1) === 'auth')){
					sys.log('ThothServer: receiving an AUTH request on the REST side');
					var authdata = "";
					request.addListener("data", function(chunk){ // gather data
						authdata += chunk;
					});
					request.addListener("end", function(){ // finished gathering data, call AUTH
						serverObj.AUTH(request,authdata,response);
					});
					callback('handleAUTHRequest',true);
				}
				else callback('handleAUTHRequest',false);
			},

			handleSession: function(path,method,request,response,callback){
				var msg;
				if(serverObj.forceAuthentication){
					var receivedCookieHeader = request.headers['cookie'];
					var receivedUserName = request.headers['username'];
					//sys.puts('cookieHeader received: ' + receivedCookieHeader);
					if(receivedCookieHeader && receivedUserName){
						//check the session
						var hasSession = serverObj.sessionModule.checkSession(receivedUserName,receivedCookieHeader);
						if(!hasSession){
							msg = 'Not logged in, invalid cookie';
							serverObj.send403(response,msg);
							callback('handleSession',true);
						} 
						callback('handleSession',false); // proper session info, so don't stop 
					}
					else {
						msg = 'Not logged in, no cookie information found';
						serverObj.send403(response,msg);
						callback('handleSession',true);
					}          
				} else callback('handleSession',false);
			},

			handleRPCGET: function(path,method,request,response,callback){
				var resource;
				if(method === 'GET'){
					resource = path.slice(1);
					if(resource && (resource.indexOf('rpc') === 0)){
						serverObj.RPC(request,resource,response);
						callback('handleRPCGET',true);
					}
					else callback('handleRPCGET',false);
				} else callback('handleRPCGET',false);
			},
			
			handleStatusGET: function(path,method,request,response,callback){
			  var resource;
			  if(method === 'GET'){
			    resource = path.slice(1);
			    if(resource && (resource.indexOf('status') === 0)){
			      serverObj.STATUS(request,response);
			      callback('handleStatusGET',true);
			    }
  			  else callback('handleStatusGET',false);
			  }
			  else callback('handleStatusGET',false);
			}
		};

		var getURL = function(request){
			var path = url.parse(request.url).pathname;
			if(serverObj.URLPrefix){ // subtract the URLPrefix from the URL
				if(path.slice(0,serverObj.URLPrefix.length) === serverObj.URLPrefix){
					path = path.slice(serverObj.URLPrefix.length, path.length);
				}
			}
			return path;
		};

		var methodDispatch = function(request,response){
			var method = request.method, reqdata="";
			if(!serverObj[method]) serverObj.send404(response);
			if(method !== 'GET'){
				request.addListener("data", function(chunk){ //gather data
					reqdata += chunk;
				});
				request.addListener("end", function(){
					var data;
					try{
						data = JSON.parse(reqdata); // Thoth crashes when this doesn't go well.. oops?
					}
					catch(e){
						data = reqdata;
					}
					serverObj[method](request,data,response); // finish gathering, call method function
				});
			}
			else {
				serverObj.GET(request,response);
			}
		}; // end handlers

		var handler = function(request,response){
		  // the concept for this walker is a combination of recursive and callbacks.
		  
			var path = getURL(request);
			var method = request.method;

      var handlerWalker = function(handlerName,isHandled){ 
        SC.RunLoop.begin();
        //sys.log('HandleWalker called by ' + handlerName + ' with isHandled ' + isHandled);
        if(!isHandled){
          var i = handlerFunctions.indexOf(handlerName) + 1;
          if(i<handlerFunctions.length){ // don't want 0 because that means that handler has not been found!
            if(i!==0){
              handlers[handlerFunctions[i]](path,method,request,response,handlerWalker);
            }
            else sys.log('ThothServer: there is a bug in handlerWalker, as handler could not be found');
          }
          else { // no handlers left, then pass on the request to the methodDispatc
            // no need to check for session, because if a session is required and there is none, the handleSession function would have stopped
            // the procedure
            methodDispatch(request,response);
          }
        }        
        SC.RunLoop.end();
      };

			if(serverObj.debug) sys.log('ThothServer: got a request for path: ' + path);
      handlers[handlerFunctions[0]](path,method,request,response,handlerWalker); // start recursive walking

/*			for(i=0,len=handlerFunctions.length;i<len;i+=1){
				isHandled = handlers[handlerFunctions[i]](path,method,request,response);
				if(isHandled){
					SC.RunLoop.end();
					return;
				} 
			}

			//still running? start the method functions
			methodDispatch(request,response);
			SC.RunLoop.end(); */
		};

		return handler;
	},
   
   // function to get the URLPrefix with a leading slash, even if the user has omitted it
   getURLPrefix: function(){
     var pref = this.URLPrefix,
         ret = (pref[0] === '/')? pref: '/' + pref;
     return ret;
   },
   
	// ===========================
	// = REST Handling functions =
	// ===========================   
   
   RPC: function(request,resource,response){
      // RPC accepts a JSON object { rpcRequest: { cacheKey: ''}}
      // call the RPC 
      // split the cacheKey from the resource
      sys.log("ThothServer: RPC called");
      var resourceInfo = resource.split('/');
      if(resourceInfo && (resourceInfo.length===2)){
         var cacheKey = resourceInfo[1];
         if(cacheKey && this.rpcModule){
            var me = this;
            var cb = function(mimeType,data){
               if(mimeType && data) me.send200(response, data, mimeType, true); // true for binaryData
               else me.send404(response,"the requested data cannot be found"); // force the end of the response if nothing can be found?              
            };
            sys.log('ThothServer: about to call rpcRetrieve on rpcModule');
            this.rpcModule.rpcRetrieve(cacheKey, cb);
         }
      }
   },
   
   AUTH: function(request,data,response){
      // when succesfully authenticated, send back a set-cookie header
      // a standard PHP session start answers with the following headers on the auth request
      /* 
      Date  Fri, 02 Jul 2010 20:14:48 GMT
      Server  Apache
      Expires Thu, 19 Nov 1981 08:52:00 GMT
      Cache-Control no-store, no-cache, must-revalidate, post-check=0, pre-check=0
      Pragma  no-cache
      Set-Cookie  Thoth_loginproto=teacher; expires=Mon, 02-Aug-2010 20:14:48 GMT
      Vary  Accept-Encoding
      Content-Encoding  gzip
      Content-Length  661
      Keep-Alive  timeout=15, max=200
      Connection  Keep-Alive
      Content-Type  text/html
      */
     
      var givenCookieHeader = request.headers.Cookie,
          // data should be json stuff
          dataObj = JSON.parse(data),
          me = this,
          user = dataObj.user || dataObj.auth.user, // support both the websocket and orginal XHR auth req type
          passwd = dataObj.passwd || dataObj.auth.passwd,
          application = dataObj.application || dataObj.auth.application;
      
      var callback = function(authResult, message){
        if(authResult){
          // successfull auth
          // need to get the user data into the session info somehow
          var newCookieHeader = me.sessionModule.createSession(authResult);
          response.writeHead(200, {'Content-Type': 'application/json', 'Set-Cookie':newCookieHeader });
          var sessionInfoObj = querystring.parse(newCookieHeader,';','=');
          var receivedSessionKey = sessionInfoObj[me.sessionModule.sessionName];
          var ret = API.createAuthReply(authResult.role,receivedSessionKey);
          sys.log("about to reply with: " + ret);
          response.write(JSON.stringify(ret));
       }
       else {
          response.writeHead(200, {'Content-Type': 'application/json'});
          response.write(JSON.stringify(API.createAuthReply(null,null,authResult)));
          //response.write("<br/>auth result: " + authResult);
          //response.write('<br/>received cookie: ' + givenCookieHeader);
       }
       response.end();         
    };
    this.authModule.checkAuth(user, passwd,false,callback,application);    
  },
    
  GET: function(request,response){
    var me = this, urlInfo, path, resourcePath, resource, req, cb,
     		receivedUserName = request.headers['username'],
    		urlPrefix = this.getURLPrefix(),
				getAction,
    		userData = this.sessionModule.getUserData(receivedUserName);
    
    urlInfo = url.parse(request.url, true); // parse query string
    path = urlInfo.pathname;
    resourcePath = (this.URLPrefix && (path.indexOf(urlPrefix) === 0))? path.slice(this.URLPrefix.length + 1): path.slice(1); // return the entire string except the first character (being a "/")
    // Requests are either a fetch all, or a refresh (resource for fetchall, resource/id for refresh)
    resource = resourcePath.split("/"); // get an array with resource and possible id
    
    cb = function(records){
      var res;
			if(records){
	      sys.log('Server: GET cb records = ' + sys.inspect(records));
				me.send200(response,records,'application/json');//this is not binary safe... 				
			}
      else {
        res = API.createErrorReply(Constants.ACTION_FETCH,Constants.ERROR_DATAINCONSISTENCY,{});
        me.send200(response,res);
      }
    };
    
    if(resource.length === 1){ // fetchall
      req = API.createStoreRequest({ bucket: resource[0], primaryKey: urlInfo.query.primaryKey || API.getPrimaryKey() },
        userData,
        Constants.ACTION_FETCH);
    }
    else { // refresh
      req = API.createStoreRequest({ bucket: resource[0], primaryKey: urlInfo.query.primaryKey || API.getPrimaryKey(), key: resource[1]},
        userData,
        Constants.ACTION_REFRESH);
    }    

		getAction = this.createStoreAction(req,null,cb,Constants.REQUESTTYPE_REST); // get action
		// and fire off the actual requests
		if(this.policyModule){
			this.policyModule.checkPolicy(req,null,getAction);
		}       
		else {
			getAction(YES);
		}
  },
   
  //couple of options with POST: 
  // - POST of a query (POST to resource, with a body of a fetchRequest)
  // - POST of a record (POST to resource, with a body of a createRecordRequest) //something similar that is
  
	POST: function(request,data,response){
		var me = this, urlInfo, path, resourcePath, resource, req, cb, storeRequest, res,
		receivedUserName = request.headers['username'],
		urlPrefix = this.getURLPrefix(),
		postAction,
		userData = this.sessionModule.getUserData(receivedUserName);

		urlInfo = url.parse(request.url, true); // parse query string
		path = urlInfo.pathname;
		resourcePath = (this.URLPrefix && (path.indexOf(urlPrefix) === 0))? path.slice(this.URLPrefix.length + 1): path.slice(1); // return the entire string except the first character (being a "/")
		// Requests are either a fetch all, or a refresh (resource for fetchall, resource/id for refresh)
		resource = resourcePath.split("/"); // get an array with resource and possible id

		var fetchCb = function(records){
			if(records.recordResult){
				me.send200(response, { fetchResult: { bucket: resource[0], records: records.recordResult } },'application/json');
			}
		};

		var createCb = function(records){
			me.send200(response, { fetchResult: { bucket: resource[0], records: records } },'application/json');
		};
		sys.log('fetchdata = ' + sys.inspect(data));

		if(data.fetch){
			storeRequest = API.createStoreRequest(data.fetch,userData,Constants.ACTION_FETCH);
			postAction = this.createStoreAction(storeRequest,null,fetchCb,Constants.REQUESTTYPE_REST);
		}
		else {
			if(data.record){
				storeRequest = API.createStoreRequest(data,userData,Constants.ACTION_CREATE);
				postAction = this.createStoreAction(storeRequest,null,createCb,Constants.REQUESTTYPE_REST);
			}
			else {
				res = API.createErrorReply(Constants.ACTION_FETCH,Constants.ERROR_DATAINCONSISTENCY,{});
				me.send200(response,res);
				return;
			}      
		}

		if(this.policyModule){
			this.policyModule.checkPolicy(storeRequest,null,postAction);
		}       
		else {
			postAction(YES);
		}
	},
   
	PUT: function(request,data,response){
		sys.log('Thoth Server: The REST command PUT has not been implemented');      
	},

	DELETE: function(request,data,response){
		sys.log('Thoth Server: The REST command DELETE has not been implemented');
	},

  STATUS: function(request,response){
    //gather info:
    var sessModule = this.sessionModule;
    var i,count = 0;
    var statusText = "";
    var memUse = process.memoryUsage();
    
    var round = function(value,numdec){
      var factor = Math.pow(10,numdec);
      return Math.round(value*factor)/factor;
    };
    
    //session info
    for(i in sessModule._userCacheObjects){
      if(sessModule._userCacheObjects.hasOwnProperty(i)){
        count += 1;
      }
    }
    statusText += count + " objects in session. <br/><br/>";
    
    statusText += "Memory usage: <br/>";
    for(i in memUse){
      if(memUse.hasOwnProperty(i)){
        statusText += i + ": " + round(memUse[i]/1024,2) + "kB (" + round(memUse[i]/(1024*1024),3) + "MB)<br/>";
      }
    }
    this.send200(response,statusText,"text/html");
  },

	// ==========================================
	// = Methods for registering temporary urls =
	// ==========================================
  
  // this function registers temporary resources, for example for RPC or file anonymising purposes
  // bucket = resource, key is the resource id, 
  // limit contains a limit for which the url will be available. How that limit is parsed depends on the limitType.
  // limitType is either 'num' (number of times retrievable, 0 for unlimited access) or 'datetime' (timestamp: var t = new Date(); datetime = t.toString();)
  // data is the data to return, but what the server returns depends on the actual request depends on mimetype.
  // if datatype is 'application/json' it will return the data directly, if the mimetype is anything else, it will 
  // assume data contains an file path or url and will return the data in that file with the given mimetype
  // if shouldAnonymize is true, and mimeType is a digital file, it will make up a fake file name
  // returns true when saved.
  registerTemporaryURL: function(bucket,key,data,mimeType,limit,limitType,shouldAnonymize){
    if(!this.tempStore){
      sys.log('Thoth Server: unable to register temporary url because there is no temporary store??');
      return false;
    }
    // the temporary url will be stored in the temp store with tempURL as bucket and the expected resource as key
    var record = {
      data: data,
      mimeType: mimeType,
      limit:limit,
      limitType: limitType,
      shouldAnonymize: shouldAnonymize
    };
    this.tempStore.createDBRecord(this._createTempURLStoreRequest(bucket,key,record));
  },
  
  // This function will check whether the requested url fits any registered temporary url and handle the request.
  // if no temporary url has been found, it will call the callback with the original request and response
  getTemporaryURL: function(request,response,callback){
    var me = this;
    var path = url.parse(request.url).pathname;
    if(this.URLPrefix && (path.indexOf(this.URLPrefix) === 0)){ // slice off url prefix if exists
      path = path.slice(this.URLPrefix.length);
    }
    
    var resource = (path[0] === '/')? path.slice(1): path; // remove the first character if it is a "/" 
    var parts = resource.split('/'); 
    if(parts.length === 2){ // if not, someone is playing with us... and we should ignore it
      var bucket = parts[0];
      var key;
      
      if(parts[1].indexOf('?') > 0) key = parts[1].split('?')[0];
      else key = parts[1]; // only get the key and ignore any URL parameters if present

      this.tempStore.refreshDBRecord(this._createTempURLStoreRequest(bucket,key),function(rec){
        if(rec){ // something found, so parse it
          if(me._checkTempURLValidity.call(me,bucket,key,rec)){ // function auto-updates tempStore
            // valid url, so give out info
            me._respondToTempURL.call(me,rec,response);
            return;
          }  
        }
        callback(request,response);
      });
    }
  },
  
  _respondToTempURL: function(record,response){
    if(record){ // just in case
      switch(record.mimeType){
        case 'application/json': 
            response.writeHead(200, {'Content-Type': record.mimeType });
            response.write(record.data);
            response.end();
          break;
        default: // assume a digital file
          fs.readFile(record.data,'binary',function(err,data){
            if(err){
              sys.log('ThothServer: tmpURL: trying to send file, but encountered error while reading file');
              this.send404(response);
            } 
            else {
              response.writeHead(200, {'Content-Type': record.mimeType });
              response.write(data,'binary');
              response.end();
            }
          });
      }
    }
  },
  
  // function to check the validity of the record and update the information if necessary, or destroy the record
  // returns true when valid, or false when invalid
  _checkTempURLValidity: function(bucket,key,record){
    if(record){
      var ret = false;
      switch(record.limitType){
        case 'num': 
          if(record.limit > 1){
            record.limit -= 1;
            this.tempStore.updateDBRecord(this._createTempURLStoreRequest(bucket,key,record));
          }
          if(record.limit === 1){
            this.tempStore.deleteDBRecord(this._createTempURLStoreRequest(bucket,key)); // remove if == 1            
          }
          if(record.limit < 0){
            this.tempStore.deleteDBRecord(this._createTempURLStoreRequest(bucket,key)); // remove if smaller than 0, because someone is playing us            
          }
          // let 0 fall through as 0 means unlimited access
          ret = true;
          break;
        case 'datetime':
          var now = new Date(),
              recTimeStamp = new Date(record.limit),
              diff = now - recTimeStamp;
          
          if(diff < 0){ // restriction time passed, so remove rec
            this.tempStore.deleteDBRecord(this._createTempURLStoreRequest(bucket,key)); // remove 
          }
          else ret = true;
          break;
        default: ret = false;
      }
      return ret;
    } 
    else return false;
  },
  
  _createTempURLStoreRequest: function(bucket,key,record){
    var newKey = [bucket,key].join('/');
    var storeRequest = {
      bucket: 'tempURL',
      key: newKey,
      recordData: record
    };
    return storeRequest;        
  },
  
  destroyTemporaryURL: function(bucket,key){
    if(!this.tempStore){
      sys.log('Thoth Server: unable to destroy temporary url because there is no temporary store??');
      return false;
    }

    this.tempStore.deleteDBRecord(this._createTempURLStoreRequest(bucket,key));
  },
   
	// ==================================
	// = Methods used by SocketClients =  
	// ==================================

	onFetch: function(fetchReq,userData,callback){
		// the onFetch function is called to do the back end call and return the data
		// as there is no change in the data, the only thing it needs to do versus
		// the server cache is to update the server cache with the records the current
		// client / sessionKey combination requested.
		// this function uses a callback to return the result of the fetch so the function can
		// be used as you would like...

		//sys.log('Server.onFetch called');

		var	fetchAction, 
				returnData = fetchReq.returnData,
				me = this;
		//var clientId = [userData.user,userData.sessionKey].join("_");
		//var storeRequest = this._createStoreRequest(fetchinfo,userData,Constants.ACTION_FETCH);
		var storeRequest = API.createStoreRequest(fetchReq,userData,Constants.ACTION_FETCH);

		if(API.hasInconsistency(storeRequest)){
			callback(API.createErrorReply(Constants.ACTION_FETCH,Constants.ERROR_DATAINCONSISTENCY,returnData));
			return; 
		}

		// first define the function. The idea is that no policy is the same as always allow
		// so the function is defined as if there is always a policy system, so it can be
		// used as a policyModule callback

		fetchAction = this.createStoreAction(storeRequest,returnData,callback,Constants.REQUESTTYPE_XHR);
		// now do the actual data check
		if(this.policyModule){
			this.policyModule.checkPolicy(storeRequest,null,fetchAction);
		}       
		else {
			fetchAction(YES);
		}
	},
  
	onRefresh: function(refreshReq,userData,callback){
		// the onRefresh function is called to do the back end call and return the
		// data. As there is probably no change in data, we don't have to let
		// other clients know. For consistency, let's store the record in the session
		// information anyway to update the timestamp, maybe it can have some nice 
		// purpose in the future
		//sys.log("ThothServer onRefresh called");
		var	returnData = refreshReq.returnData,
				refreshAction;
		//var storeRequest = this._createStoreRequest(refreshRec,userData,Constants.ACTION_REFRESH);
		var storeRequest = API.createStoreRequest(refreshReq,userData,Constants.ACTION_REFRESH);
		if(API.hasInconsistency(storeRequest,this.store)){
			if(this.debug) sys.log("Found inconsistency in storeRequest " + sys.inspect(storeRequest));
			callback(API.createErrorReply(Constants.ACTION_REFRESH,Constants.ERROR_DATAINCONSISTENCY,returnData));
			return;
		} 

		var me = this;
		var clientId = [userData.user,userData.sessionKey].join("_");
		if(refreshReq.bucket && refreshReq.key){
			refreshAction = this.createStoreAction(storeRequest,returnData,callback,Constants.REQUESTTYPE_XHR);
			if(this.policyModule){
				this.policyModule.checkPolicy(storeRequest,storeRequest.recordData,refreshAction);
			}
			else {
				refreshAction(YES);
			}
		}
		else {
			sys.log("ThothServer received an invalid refreshRecord call:");
			sys.log("The offending message is: " + JSON.stringify(refreshReq)); 
		} 
	},
  
  distributeChanges: function(storeRequest, originalUserData){
    var me = this, 
        matchingUserSessions,
        action = storeRequest.action,
        request = API.createAPIRequest(storeRequest,action);
    
    sys.log('distributing change: ' + sys.inspect(originalUserData));
		// possible issue here: at the distribution the policies are not enforced... which is not good
		

    var performDistributeOrQueue = function(request,user,sessionKey){
      sys.log('trying to distribute to ' + user + " with sk: " + sessionKey);
      var result = me.socketIO.sendDataTo(user,sessionKey,request);
      //always save in session
      me.sessionModule.storeBucketKey(user,sessionKey,request.bucket,request.key);
      if(!result){ // if not sent, queue
        sys.log('distribute failed, queuing...');
        me.sessionModule.queueRequest(user,sessionKey,request);
      }
    }; 
    
    var determineActionType = function(sessionInfo){
      var curUser = sessionInfo.user,
          curSessionKey = sessionInfo.sessionKey,
          curMatchType = sessionInfo.matchType,
          whatToDo = action + curMatchType;
      
      if((originalUserData.user === curUser) && (originalUserData.sessionKey === curSessionKey)) return; // prevent distribution to original client... 
      
      // matrix: action - matchType
      // actions that matter: ACTION_CREATE, ACTION_UPDATE, ACTION_DELETE
      // matchTypes are 'bucketkey' and 'query' => Constants.DISTRIBUTE_QUERY + Constants.DISTRIBUTE_BUCKETKEY           
          
      switch(whatToDo){
        case (Constants.ACTION_CREATE+Constants.DISTRIBUTE_BUCKETKEY): // in contrast with previous actions, just distribute
          performDistributeOrQueue(request,curUser,curSessionKey);
          break;
        case (Constants.ACTION_CREATE+Constants.DISTRIBUTE_QUERY): 
          performDistributeOrQueue(request,curUser,curSessionKey);
          break;
        case (Constants.ACTION_UPDATE+Constants.DISTRIBUTE_BUCKETKEY): 
          performDistributeOrQueue(request,curUser,curSessionKey);
          break;
        case (Constants.ACTION_UPDATE+Constants.DISTRIBUTE_QUERY):
          performDistributeOrQueue(request,curUser,curSessionKey); 
          break;
        case (Constants.ACTION_DELETE+Constants.DISTRIBUTE_BUCKETKEY): 
          performDistributeOrQueue(request,curUser,curSessionKey); 
          break;
        case (Constants.ACTION_DELETE+Constants.DISTRIBUTE_QUERY): // do nothing, as the record should not exist at the client
          break;
        default: sys.log('Distribute records: default whatToDo should not happen at all. Major error!!');
      }         
    };

    // get all matching sessions and determine what to do with it.
    matchingUserSessions = this.sessionModule.getEligableUserSessions(storeRequest);     
    matchingUserSessions.forEach(determineActionType);
  },

	// as a side note: I started first with the REST interface, so that is not part of the Listeners
	// and in essence it seems not to be necessary if the socketIO listener also can do the other types of 
	// client as is the concept of socket-io...
	// so there should be only one listener...
   
	onCreate: function(createReq,userData,callback){
		var	storeRequest = API.createStoreRequest(createReq,userData,Constants.ACTION_CREATE),
				returnData = createReq.returnData,
				createAction;

		if(API.hasInconsistency(storeRequest,this.store)){
			callback(API.createErrorReply(Constants.ACTION_CREATE,Constants.ERROR_DATAINCONSISTENCY,returnData));
			return;
		}

		var clientId = [userData.user,userData.sessionKey].join("_");
		var me = this;
		if(storeRequest.bucket && clientId){
			createAction = this.createStoreAction(storeRequest,returnData,callback,Constants.REQUESTTYPE_XHR);
			if(this.policyModule){
				this.policyModule.checkPolicy(storeRequest,storeRequest.recordData,createAction);
			}
			else {
				createAction(YES);
			}
		}
	},
   
   /*
      the record handling atm is very much based on what is in the record (like the bucket and key)
      It might be wise to change the system here a bit, resulting in not touching the record data at all
      but using the storeRequest instead
   */
   
	onUpdate: function(updateReq,userData,callback){
		var updateAction,
		    returnData = updateReq.returnData,
		    storeRequest = API.createStoreRequest(updateReq,userData,Constants.ACTION_UPDATE);
		    
		if(API.hasInconsistency(storeRequest,this.store)){
			if(this.debug) sys.log('Inconsistency in updateRequest: ' + sys.inspect(storeRequest));
			callback(API.createErrorReply(Constants.ACTION_UPDATE,Constants.ERROR_DATAINCONSISTENCY,returnData));
			return;
		}
		var clientId = [userData.user,userData.sessionKey].join("_");
		var me = this;
		if(storeRequest.bucket && storeRequest.key && clientId){
			updateAction = this.createStoreAction(storeRequest,returnData,callback,Constants.REQUESTTYPE_XHR);
			if(this.policyModule){
				this.policyModule.checkPolicy(storeRequest,storeRequest.recordData,updateAction);
			}
			else {
				updateAction(YES);
			}
		}
	},
   
	onDelete: function(deleteReq,userData,callback){
		var bucket = deleteReq.bucket,
				key = deleteReq.key,
				destroyAction,
				returnData = deleteReq.returnData,
				record = deleteReq.record; // this must be here, as we need the record data to distribute...
		// assign the bucket and key of the request to the record if they don't exist already... 
		// we need the bucket and key on the record in order to be able to distribute 
		//if(!record.bucket && bucket) record.bucket = bucket; 
		//if(!record.key && key) record.key = key;

		var clientId = [userData.user,userData.sessionKey].join("_");
		var me = this;
		if(bucket && key && clientId && record){ 
			var storeRequest = API.createStoreRequest(deleteReq,userData,Constants.ACTION_DELETE);
			if(API.hasInconsistency(storeRequest, this.store)){
				callback(API.createErrorReply(Constants.ACTION_DELETE,Constants.ERROR_DATAINCONSISTENCY,returnData));
				return;
			}
			destroyAction = this.createStoreAction(storeRequest,returnData,callback,Constants.REQUESTTYPE_XHR);
			if(this.policyModule){
				this.policyModule.checkPolicy(storeRequest,storeRequest.recordData,destroyAction);
			}
			else {
				destroyAction(YES);
			}
		}
		else {
			callback(API.createErrorReply(Constants.ACTION_DELETE,Constants.ERROR_DATAINCONSISTENCY,returnData));         
			sys.log("Server: Trying to destroy record without providing the proper record data!");
			return;
		}
	},
   
	onRPCRequest: function(rpcRequest,userdata,callback){
	  var fn, params, err;
	  
		sys.log("ThothServer: onRPCRequest called");
		if(this.rpcModule){
			if(rpcRequest){
				sys.log("ThothServer: received RPC request from client: " + userdata.username);
				fn = rpcRequest.functionName;
				params = rpcRequest.params;
				this.rpcModule.callRPCFunction(fn,params,function(data){
					data.rpcResult.returnData = rpcRequest.returnData;
					callback(data);
				});
			}
		}
		else {
		  err = API.createErrorReply(Constants.ACTION_RPC, Constants.ERROR_RPCNOTLOADED, rpcRequest.returnData);
		  callback(err);
		  sys.log('Server: Trying to perform an RPC request, but the RPC module is not loaded in the configuration');
	  }
	},

	onLogout: function(logoutReq,userdata,callback){

		var user = logoutReq.user,
				sessionKey = logoutReq.sessionKey,
				sesMod = this.sessionModule,
				client = this.socketIO.clientFor(user,sessionKey),
				me = this,
				skOnly = true;
		
		if((userdata.user === user) && (userdata.sessionKey === sessionKey)){
			//success
			// find session
			sesMod.checkSession(user,sessionKey,skOnly,function(hasSession,userdata){
			  sys.log('ThothServer: logout of user ' + user + ' successful');
			  if(hasSession){
			    sesMod.logout(user,sessionKey,skOnly);
			  }
			  client.sessionCheckTimer.invalidate();
			  client.handshake.THOTH_isAuthenticated = false;
			  if(callback) callback({logoutSuccess: {} }); // even if no session, still logout
			});
		}
		else {
			//failure
			sys.log('ThothServer: Error on logout of user ' + user);
			if(callback) callback({logoutError: { errorMessage: 'Inconsistency in logout request'}});
		}
	},
	
	
	//Reload actions:
	// actions to reload certain parts of the system while running, very useful in adjusting settings
	// without having to stop the server, and also very useful in debugging
	reloadPolicyModule: function(){
		//copy user settings:
		var filterRecords = this.policyModule.filterRecords;
		var policyFile = this.policyModule.policyFile;
		delete require[this.policyModule.classFilename + '.js']; // force a re-require
		this.policyModule = require(this.policyModule.classFilename).Policies.create({
			filterRecords: filterRecords,
			policyFile: policyFile
		});
	}
	
});
