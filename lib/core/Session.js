/*
ThothSession class: to keep track of logged in users and to have timeouts checked
*/

//if(!global.SC) require('./sc/runtime/core');

var querystring = require('querystring'); // for session key parsing
var sys = require('sys');
var UserCache = require('./UserCache').UserCache;
var Tools = require('./Tools');

exports.Session = SC.Object.extend({
   
   sessionName: 'Thoth', // lets choose some default
   
   sessionCookieExpireDuration: 31, // duration in days
   
   timeOutDuration: 15, //(timeout in minutes) 15 minutes standard 
   
   // some notes on timeOutDuration: if set too high it may choke the server as at the moment the idea is to keep
   // every user that has a session up to date regarding changes in the data, even if there is no connection
   // It may be an idea to use riak or something else as a kind of temporary storage...?

   /*
     _loggedInUsers is an object containing objects which contain information about the last time a specific user has been seen
     or heard of, and the sessionkey the user is using.
     so something like: 
     { 'user': 
         { 
            sessionKeys: [''],
            lastSeen: [], // date in milliseconds, 
            sessionData: [ThothUserCache.create()]
         }
     }
     
     every time a user makes contact, the current date is compared to the lastSeen date, and if the difference is larger than the 
     given timeOutDuration, the user is automatically logged out. It means the user information is removed from the 
     _loggedInUsers object which should then automatically lead to be forced to login again...
    
     a user can have more than one session key for every application that has logged in successfully. 
     sessionKeys and lastSeen are both arrays and have the same indexes.
     The sessionKey is looked up first, and the index retrieved from that is used to get the correct lastSeen data
     
   */
   
   _loggedInUsers: {},  // an object containing objects containing info
   
   _knownUsers: [], // an array containing the keys of _loggedInUsers

   _timeOutDurationCache: null, // to cache the calculation of timeOutDuration to milliseconds
   
   checkSession: function(user,sessionInfo,sessionKeyOnly){
      // function to check whether a user is still logged in
      // sessionInfo is the entire string of data sent by the client in the Cookie header of the request
      // it may be wise to have the user name in a http header to make session hijacking a bit more difficult
      // lets force that behaviour for the moment, and rewrite the stuff when a better way can be found
      
      // process sessionInfo
      var sessionName = this.sessionName;
      var receivedSessionKey = "";
      if(!sessionKeyOnly){
         var sessionInfoObj = querystring.parse(sessionInfo,';','=');
         receivedSessionKey = sessionInfoObj[sessionName];         
      }
      else receivedSessionKey = sessionInfo;
      
      //sys.puts(sys.inspect(sessionInfoObj));
      // returns YES or NO depending on whether the user is still logged in
      var timeout_in_ms = this._timeOutDurationCache;
      if(!timeout_in_ms){ // if there is no cache yet, create it
         timeout_in_ms = this.timeOutDuration * 60 * 1000;
         this._timeOutDurationCache = timeout_in_ms;
      }
      var curUserData = null;
      if(user){
         curUserData = this._loggedInUsers[user]; // get the user data
      }
      if(curUserData){ // if it exists, check it
         //sys.log('ThothSession: curUserData exists: ' + sys.inspect(curUserData));
         var sesKeyIndex = curUserData.sessionKeys.indexOf(receivedSessionKey);
         if(sesKeyIndex> -1){
            var lastSeen = curUserData.lastSeen[sesKeyIndex];
            var now = new Date().getTime();
            if((now - lastSeen) > timeout_in_ms){ // diff between lastseen and now too large?
               // delete user key
               this._loggedInUsers[user] = undefined;
               return NO; // 
            }
            else { // active session
               // first set the new date to now
               this._loggedInUsers[user].lastSeen = now; // update the actual user data
               return YES; // use cached data for speed.
            }
         }
         else return NO; // receivedSessionKey given does not match any known session keys
      }
      else return NO; // no user data found for received user name
   },
   
   getUserData: function(user){
     if(user && this._loggedInUsers[user]) return this._loggedInUsers[user].userData;
     else return false;
   },
   
   createSession: function(userData,sessionKeyOnly){
      // a function to create a user session when a user has logged in successfully
      // the function returns the set-cookie header info, or in case sessionKeyOnly is set, only the sessionKey
      //sys.log('ThothSession: userData received: ' + JSON.stringify(userData));
      var user = userData.user;
      // first create a session key
      var newSessionKey = Tools.generateSessionKey();
      // then set the user information and add to any existing stuff
      if(!this._loggedInUsers[user]){ // no existing info, create 
         //sys.log('ThothSession: no existing userdata for user: ' + user);
         this._loggedInUsers[user] = { 
            userData: userData,
            sessionKeys: [newSessionKey],
            lastSeen: [new Date().getTime()],
            sessionData: [UserCache.create()]
         }; 
         this._knownUsers.push(user);        
      }
      else { // 
         // if for some strange reason something has gone wrong during the creation of the previous object
         // make sure the stuff works anyway...
         if(this._loggedInUsers[user].sessionKeys instanceof Array){
            this._loggedInUsers[user].sessionKeys.push(newSessionKey);
         } 
         else {
            this._loggedInUsers[user].sessionKeys = [newSessionKey]; 
         }
         if(this._loggedInUsers[user].lastSeen instanceof Array){
            this._loggedInUsers[user].lastSeen.push(new Date().getTime());            
         }
         else {
            this._loggedInUsers[user].lastSeen = [new Date().getTime()];
         }
         if(this._loggedInUsers[user].sessionData instanceof Array){
            this._loggedInUsers[user].sessionData.push(UserCache.create());            
         }
         else {
            this._loggedInUsers[user].sessionData = [UserCache.create()];
         }
      }
      var sessionName = this.sessionName;
      var expDate = new Date();
      expDate.setDate(expDate.getDate() + 31);
      var ret = sessionKeyOnly? newSessionKey: sessionName + '=' + newSessionKey + '; expires=' + expDate.toString();
      return ret;
   },
   
   logout: function(user,sessionInfo,sessionKeyOnly){
      // function to logout a user and remove the session information
      var receivedSessionKey = "";
      var sessionName = this.sessionName;
      if(sessionKeyOnly){
         var sessionInfoObj = querystring.parse(sessionInfo,';','=');
         receivedSessionKey = sessionInfoObj[sessionName];         
      }
      else receivedSessionKey = sessionInfo;
      
      if(this._loggedInUsers[user]){
         var curSesIndex = this._loggedInUsers[user].sessionKeys.indexOf(receivedSessionKey);
         if(curSesIndex>-1){
            //key exists, remove both key and lastSeen
            this._loggedInUsers[user].sessionKeys.removeAt(curSesIndex);
            this._loggedInUsers[user].lastSeen.removeAt(curSesIndex);
         } // sessionkey doesn't exist, ignore
         // always check if there are any sessions left
         if(this._loggedInUsers[user].sessionKeys.length === 0){
            // remove the user from the _loggedInUsers as well as the knownUsers cache
            delete this._loggedInUsers[user];
            this._knownUsers.removeObject(user);
         }
      }
      // if the user doesn't exist anymore in the session info, ignore
   },
   
   // functions to pass on requests to the sessions user cache
   
   storeQuery: function(user,sessionKey,bucket,conditions,parameters){
      //sys.puts("Storing query for user " + user + " and sessionKey: " + sessionKey + " with bucket: " + bucket + " and conditions " + conditions + " and parameters " + JSON.stringify(parameters));
      if(this._loggedInUsers && this._loggedInUsers[user]){
         var sesIndex = this._loggedInUsers[user].sessionKeys.indexOf(sessionKey);
         if(sesIndex > -1){ // session found
            return this._loggedInUsers[user].sessionData[sesIndex].storeQuery(bucket,conditions,parameters);
         }
      }
   },
   
   storeBucketKey: function(user,sessionKey,bucket,key,timestamp){
      if(this._loggedInUsers && this._loggedInUsers[user]){
         var sesIndex = this._loggedInUsers[user].sessionKeys.indexOf(sessionKey);
         if(sesIndex > -1){ // session found
            return this._loggedInUsers[user].sessionData[sesIndex].storeBucketKey(bucket,key,timestamp);
         }
      }
   },
   
   storeRecords: function(user,sessionKey,records){
      if(this._loggedInUsers && this._loggedInUsers[user]){
         var sesIndex = this._loggedInUsers[user].sessionKeys.indexOf(sessionKey);
         if(sesIndex > -1){ // session found
            return this._loggedInUsers[user].sessionData[sesIndex].storeRecords(records);
         }
      }  
   },
   
   deleteBucketKey: function(user,sessionKey,bucket,key){
      if(this._loggedInUsers && this._loggedInUsers[user]){
         var sesIndex = this._loggedInUsers[user].sessionKeys.indexOf(sessionKey);
         if(sesIndex > -1){ // session found
            return this._loggedInUsers[user].sessionData[sesIndex].deleteBucketKey(bucket,key);
         }
      }   
   },
   
   deleteRecords: function(user,sessionKey,records){
      if(this._loggedInUsers && this._loggedInUsers[user]){
         var sesIndex = this._loggedInUsers[user].sessionKeys.indexOf(sessionKey);
         if(sesIndex > -1){ // session found
            return this._loggedInUsers[user].sessionData[sesIndex].deleteRecords(records);
         }
      }      
   },
   
   shouldReceive: function(user,sessionKey,record){
      if(this._loggedInUsers && this._loggedInUsers[user]){
         var sesIndex = this._loggedInUsers[user].sessionKeys.indexOf(sessionKey);
         if(sesIndex > -1){ // session found
            return this._loggedInUsers[user].sessionData[sesIndex].shouldReceive(record);
         }
         return NO;
      }
   },
   
   queueRequest: function(user,sessionKey,request){
      if(this._loggedInUsers && this._loggedInUsers[user]){
         var sesIndex = this._loggedInUsers[user].sessionKeys.indexOf(sessionKey);
         if(sesIndex > -1){ // session found
            return this._loggedInUsers[user].sessionData[sesIndex].queueRequest(request);
         }
      }
   },
   
   retrieveRequestQueue: function(user,sessionKey){
      if(this._loggedInUsers && this._loggedInUsers[user]){
         var sesIndex = this._loggedInUsers[user].sessionKeys.indexOf(sessionKey);
         if(sesIndex > -1){ // session found
            return this._loggedInUsers[user].sessionData[sesIndex].retrieveRequestQueue();
         }
      }
   },
   
   getMatchingUserSessionsForRecord: function(storeRequest){
      // a really bad name for what this record does, but that can be changed later...
      // the purpose of the function is to check all existing session data to check whether there is a match
      // between the given record and a specific session
      // it returns an array with users and sessions and for what reason a match was found (bucketkey or query)
      //sys.puts("Running getMatchingUserSessionsForRecord with record " + JSON.stringify(record));
      
      var ret = [], 
          knownUsers = this._knownUsers,
          curSessionCache, isMatch,curUser,curUserInfo,numSessions,i,len;
      for(i=0,len=knownUsers.length;i<len;i++){
         curUser = knownUsers[i];
         if(curUser){
            curUserInfo = this._loggedInUsers[curUser];
            numSessions = curUserInfo.sessionKeys.length; // sessionKeys rules the set
            for(var j=0;j<numSessions;j++){
               //sys.puts("Probing match for user " + curUser + " with sessionKey " + curUserInfo.sessionKeys[j]);
               curSessionCache = curUserInfo.sessionData[j];
               isMatch = curSessionCache.shouldReceive(storeRequest);
               if(isMatch){
                  ret.push({user: curUser, sessionKey: curUserInfo.sessionKeys[j], matchType: isMatch});
               }
            }
         }
      }
      return ret;
   } 
   
});
