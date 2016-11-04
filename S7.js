const assert = require('assert')
const EventEmitter = require('events')

class Emitter extends EventEmitter{}

const eventor = new Emitter()

var net = require("net");
var util = require("util");


var options = {
	 addRemoveArray:	[]
	,connectCBIssued:	false
	,connectionID:	'UNDEF'
	,connectionParams:	{ 
		 connection_name: "CONX_S2"
		,port: 102
		,host: '192.168.8.106'
	}
	,connectReq:	new Buffer([0x03, 0x00, 0x00, 0x16, 0x11, 0xe0, 0x00, 0x00, 0x00, 0x02, 0x00, 0xc0, 0x01, 0x0a, 0xc1, 0x02, 0x01, 0x00, 0xc2, 0x02, 0x01, 0x02])
	,connectTimeout:	undefined
	,doNotOptimize:	false
	,dropped:	()=>{ console.error('Connection dropped!') }
	,dropConnectionTimer:	null
	,error:	console.error
	,instantWriteBlockList:	[]
	,isoclient:	undefined
	,isoConnectionState:	0
	,connected:	()=>{ console.log('Connection established.') }
	,globalReadBlockList:	[]
	,globalWriteBlockList:	[]
	,globalTimeout:	1500	// In many use cases we will want to increase this
	,masterSequenceNumber:	1
	,maxGap:	5
	,maxPDU:	960
	,maxParallel:	8
	,negotiatePDU:	new Buffer([0x03, 0x00, 0x00, 0x19, 0x02, 0xf0, 0x80, 0x32, 0x01, 0x00, 0x00, 0x00, 0x00, 0x00, 0x08, 0x00, 0x00, 0xf0, 0x00, 0x00, 0x08, 0x00, 0x08, 0x03, 0xc0])
	,parallelJobsNow:	0
	,PDUTimeout:	undefined
	,polledReadBlockList:	[]
	,rack:	0
	,readSuccess:	(data)=>{ console.log('Data read success', data) }
	,readPacketArray:	[]
	,readPacketValid:	false
	,readReqHeader:	new Buffer([0x03, 0x00, 0x00, 0x1f, 0x02, 0xf0, 0x80, 0x32, 0x01, 0x00, 0x00, 0x08, 0x00, 0x00, 0x0e, 0x00, 0x00, 0x04, 0x01])
	,readReq:	new Buffer(1500)
	,requestMaxParallel:	8
	,requestMaxPDU:	960
	,resetPending:	false
	,resetTimeout:	undefined
	,slot:	2
	,translation:	(arg)=>{
		return arg;
	}
	,writeSuccess:	()=>{ console.log('Write success.') }
	,writePacketArray:	[]
	,writeInQueue:	false
	,writeReq:	new Buffer(1500)
	,writeReqHeader:	new Buffer([0x03, 0x00, 0x00, 0x1f, 0x02, 0xf0, 0x80, 0x32, 0x01, 0x00, 0x00, 0x08, 0x00, 0x00, 0x0e, 0x00, 0x00, 0x05, 0x01])
}

module.exports = (opts)=>{
	for (var X in opts) options[X] = opts[X]

	eventor.emit('load', 'S7 module successfully loaded')

	return {
		 emitter: eventor
		,options: (opts)=>{
			if (opts && (opts != {}))
				for (var X in opts) options[X] = opts[X]
			else
				return options
		}
	}
}

eventor
.on('connect', (cParam)=>{
	var self = this;

	console.log('<initiating a new connection ' + Date() + '>', 1, options.connectionID);

	// Don't re-trigger.
	if (options.isoConnectionState >= 1) { return; }
	
	cleanup();

	options.isoclient = net.connect(cParam, function() {
		onTCPConnect.apply(self, arguments);
	});

	options.isoConnectionState = 1;  // 1 = trying to connect

	options.isoclient.on('error', function() {
		options.error.apply(self, arguments);
	});
})
.on('connected', ()=>{
	console.log('Attempting to connect to host...', 0, options.connectionID);
})
.on('initialize', ()=>{
	console.log('Initialize:');

	console.dir(options.connectionParams);

	eventor.emit('initialized')

	connectNow(options.connectionParams, false);
})
.on('drop', (callback) {
	if (typeof (options.isoclient) !== 'undefined') {
		// store the callback and request and end to the connection
		options.dropped = callback;

		options.isoclient.end();
		
		// now wait for 'on close' event to trigger connection cleanup

		// but also start a timer to destroy the connection in case we do not receive the close
		options.dropConnectionTimer = setTimeout(function() {
			if (options.dropped) {
				// destroy the socket connection
				options.isoclient.destroy();
				// clean up the connection now the socket has closed
				cleanup();
				// initate the callback
				options.dropped();
				// prevent any possiblity of the callback being called twice
				options.dropped = null;
			}
		}, 2500);
	} else {
		// if client not active, then callback immediately
		callback();
	}
})

function connectError(e) {
	var self = this;

	// Note that a TCP connection timeout error will appear here.  An ISO connection timeout error is a packet timeout.
	console.log('We Caught a connect error ' + e.code, 0, options.connectionID);
	if ((!options.connectCBIssued) && (typeof (options.connected) === "function")) {
		options.connectCBIssued = true;
		options.connected(e);
	}
	options.isoConnectionState = 0;
}

readWriteError = function(e) {
	var self = this;
	console.log('We Caught a read/write error ' + e.code + ' - will DISCONNECT and attempt to reconnect.');
	options.isoConnectionState = 0;
	options.connectionReset();
}

packetTimeout = function(packetType, packetSeqNum) {
	var self = this;

	console.log('PacketTimeout called with type ' + packetType + ' and seq ' + packetSeqNum, 1, options.connectionID);

	if (packetType === "connect") {
		console.log("TIMED OUT connecting to the PLC - Disconnecting", 0, options.connectionID);
		console.log("Wait for 2 seconds then try again.", 0, options.connectionID);
		options.connectionReset();
		console.log("Scheduling a reconnect from packetTimeout, connect type", 0, options.connectionID);
		setTimeout(function() {
			console.log("The scheduled reconnect from packetTimeout, connect type, is happening now", 0, options.connectionID);
			connectNow.apply(self, arguments);
		}, 2000, options.connectionParams);
		return undefined;
	}

	if (packetType === "PDU") {
		console.log("TIMED OUT waiting for PDU reply packet from PLC - Disconnecting");
		console.log("Wait for 2 seconds then try again.", 0, options.connectionID);
		options.connectionReset();
		console.log("Scheduling a reconnect from packetTimeout, connect type", 0, options.connectionID);
		setTimeout(function() {
			console.log("The scheduled reconnect from packetTimeout, PDU type, is happening now", 0, options.connectionID);
			connectNow.apply(self, arguments);
		}, 2000, options.connectionParams);
		return undefined;
	}
	
	if (packetType === "read") {
		console.log("READ TIMEOUT on sequence number " + packetSeqNum, 0, options.connectionID);
		options.readResponse(undefined, options.findReadIndexOfSeqNum(packetSeqNum));
		return undefined;
	}
	
	if (packetType === "write") {
		console.log("WRITE TIMEOUT on sequence number " + packetSeqNum, 0, options.connectionID);
		options.writeResponse(undefined, options.findWriteIndexOfSeqNum(packetSeqNum));
		return undefined;
	}
	
	console.log("Unknown timeout error.  Nothing was done - this shouldn't happen.");
}

function onTCPConnect() {
	var self = this;

	console.log('TCP Connection Established to ' + options.isoclient.remoteAddress + ' on port ' + options.isoclient.remotePort, 0, options.connectionID);
	console.log('Will attempt ISO-on-TCP connection', 0, options.connectionID);

	// Track the connection state
	options.isoConnectionState = 2;  // 2 = TCP connected, wait for ISO connection confirmation

	// Send an ISO-on-TCP connection request.
	options.connectTimeout = setTimeout(function() {
		options.packetTimeout.apply(self, arguments);
	}, options.globalTimeout, "connect");

	options.connectReq[21] = options.rack * 32 + options.slot;

	options.isoclient.write(options.connectReq.slice(0, 22));

	// Listen for a reply.
	options.isoclient.on('data', function() {
		options.onISOConnectReply.apply(self, arguments);
	});

	// Hook up the event that fires on disconnect
	options.isoclient.on('end', function() {
		options.onClientDisconnect.apply(self, arguments);
	});

    // listen for close (caused by us sending an end)
	options.isoclient.on('close', function() {
		options.onClientClose.apply(self, arguments);

	});
}

onISOConnectReply = function(data) {
	var self = this;

	options.isoclient.removeAllListeners('data'); //options.onISOConnectReply);
	options.isoclient.removeAllListeners('error');

	clearTimeout(options.connectTimeout);

	// Track the connection state
	options.isoConnectionState = 3;  // 3 = ISO-ON-TCP connected, Wait for PDU response.

	// Expected length is from packet sniffing - some applications may be different, especially using routing - not considered yet.
	if (data.readInt16BE(2) !== data.length || data.length < 22 || data[5] !== 0xd0 || data[4] !== (data.length - 5)) {
		console.log('INVALID PACKET or CONNECTION REFUSED - DISCONNECTING');
		console.log(data);
		console.log('TPKT Length From Header is ' + data.readInt16BE(2) + ' and RCV buffer length is ' + data.length + ' and COTP length is ' + data.readUInt8(4) + ' and data[5] is ' + data[5]);
		options.connectionReset();
		return null;
	}

	console.log('ISO-on-TCP Connection Confirm Packet Received', 0, options.connectionID);

	options.negotiatePDU.writeInt16BE(options.requestMaxParallel, 19);
	options.negotiatePDU.writeInt16BE(options.requestMaxParallel, 21);
	options.negotiatePDU.writeInt16BE(options.requestMaxPDU, 23);

	options.PDUTimeout = setTimeout(function() {
		options.packetTimeout.apply(self, arguments);
	}, options.globalTimeout, "PDU");

	options.isoclient.write(options.negotiatePDU.slice(0, 25));

	options.isoclient.on('data', function() {
		options.onPDUReply.apply(self, arguments);
	});

	options.isoclient.on('error', function() {
		options.readWriteError.apply(self, arguments);
	});
}

onPDUReply = function(data) {
	var self = this;
	options.isoclient.removeAllListeners('data');
	options.isoclient.removeAllListeners('error');

	clearTimeout(options.PDUTimeout);

	// Expected length is from packet sniffing - some applications may be different
	if (data.readInt16BE(2) !== data.length || data.length < 27 || data[5] !== 0xf0 || data[4] + 1 + 12 + data.readInt16BE(13) !== (data.length - 4) || !(data[6] >> 7)) {
		console.log('INVALID PDU RESPONSE or CONNECTION REFUSED - DISCONNECTING', 0, options.connectionID);
		console.log('TPKT Length From Header is ' + data.readInt16BE(2) + ' and RCV buffer length is ' + data.length + ' and COTP length is ' + data.readUInt8(4) + ' and data[6] is ' + data[6], 0, options.connectionID);
		console.log(data);
		options.isoclient.end();
		setTimeout(function() {
			connectNow.apply(self, arguments);
		}, 2000, options.connectionParams);
		return null;
	}

	// Track the connection state
	options.isoConnectionState = 4;  // 4 = Received PDU response, good to go

	var partnerMaxParallel1 = data.readInt16BE(21);
	var partnerMaxParallel2 = data.readInt16BE(23);
	var partnerPDU = data.readInt16BE(25);

	options.maxParallel = options.requestMaxParallel;

	if (partnerMaxParallel1 < options.requestMaxParallel) {
		options.maxParallel = partnerMaxParallel1;
	}

	if (partnerMaxParallel2 < options.requestMaxParallel) {
		options.maxParallel = partnerMaxParallel2;
	}

	if (partnerPDU < options.requestMaxPDU) {
		options.maxPDU = partnerPDU;
	} else {
		options.maxPDU = options.requestMaxPDU;
	}

	console.log('Received PDU Response - Proceeding with PDU ' + options.maxPDU + ' and ' + options.maxParallel + ' max parallel connections.', 0, options.connectionID);

	options.isoclient.on('data', function() {
		options.onResponse.apply(self, arguments);
	});  // We need to make sure we don't add this event every time if we call it on data.

	options.isoclient.on('error', function() {
		options.readWriteError.apply(self, arguments);
	});  // Might want to remove the options.error listener

	//options.isoclient.removeAllListeners('error');

	if ((!options.connectCBIssued) && (typeof (options.connected) === "function")) {
		options.connectCBIssued = true;
		options.connected();
	}

}


writeItems = function(arg, value, cb) {
	var self = this, i;
	console.log("Preparing to WRITE " + arg + " to value " + value, 0, options.connectionID);
	if (options.isWriting()) {
		console.log("You must wait until all previous writes have finished before scheduling another. ", 0, options.connectionID);
		return;
	}

	if (typeof cb === "function") {
		options.writeSuccess = cb;
	} else {
		options.writeSuccess = doNothing;
	}

	options.instantWriteBlockList = []; // Initialize the array.

	if (typeof arg === "string") {
		options.instantWriteBlockList.push(stringToS7Addr(options.translation(arg), arg));
		if (typeof (options.instantWriteBlockList[options.instantWriteBlockList.length - 1]) !== "undefined") {
			options.instantWriteBlockList[options.instantWriteBlockList.length - 1].writeValue = value;
		}
	} else if (Array.isArray(arg) && Array.isArray(value) && (arg.length == value.length)) {
		for (i = 0; i < arg.length; i++) {
			if (typeof arg[i] === "string") {
				options.instantWriteBlockList.push(stringToS7Addr(options.translation(arg[i]), arg[i]));
				if (typeof (options.instantWriteBlockList[options.instantWriteBlockList.length - 1]) !== "undefined") {
					options.instantWriteBlockList[options.instantWriteBlockList.length - 1].writeValue = value[i];
				}
			}
		}
	}

	// Validity check.
	for (i = options.instantWriteBlockList.length - 1; i >= 0; i--) {
		if (options.instantWriteBlockList[i] === undefined) {
			options.instantWriteBlockList.splice(i, 1);
			console.log("Dropping an undefined write item.");
		}
	}
	options.prepareWritePacket();
	if (!options.isReading()) {
		options.sendWritePacket();
	} else {
		options.writeInQueue = true;
	}
}


findItem = function(useraddr) {
	var self = this, i;
	var commstate = { value: options.isoConnectionState !== 4, quality: 'OK' };
	if (useraddr === '_COMMERR') { return commstate; }
	for (i = 0; i < options.polledReadBlockList.length; i++) {
		if (options.polledReadBlockList[i].useraddr === useraddr) { return options.polledReadBlockList[i]; }
	}
	return undefined;
}

addItems = function(arg) {
	var self = this;
	options.addRemoveArray.push({ arg: arg, action: 'add' });
}

addItemsNow = function(arg) {
	var self = this, i;
	console.log("Adding " + arg, 0, options.connectionID);
	if (typeof (arg) === "string" && arg !== "_COMMERR") {
		options.polledReadBlockList.push(stringToS7Addr(options.translation(arg), arg));
	} else if (Array.isArray(arg)) {
		for (i = 0; i < arg.length; i++) {
			if (typeof (arg[i]) === "string" && arg[i] !== "_COMMERR") {
				options.polledReadBlockList.push(stringToS7Addr(options.translation(arg[i]), arg[i]));
			}
		}
	}

	// Validity check.
	for (i = options.polledReadBlockList.length - 1; i >= 0; i--) {
		if (options.polledReadBlockList[i] === undefined) {
			options.polledReadBlockList.splice(i, 1);
			console.log("Dropping an undefined request item.", 0, options.connectionID);
		}
	}
	//	options.prepareReadPacket();
	options.readPacketValid = false;
}

removeItems = function(arg) {
	var self = this;
	options.addRemoveArray.push({ arg: arg, action: 'remove' });
}

removeItemsNow = function(arg) {
	var self = this, i;
	if (typeof arg === "undefined") {
		options.polledReadBlockList = [];
	} else if (typeof arg === "string") {
		for (i = 0; i < options.polledReadBlockList.length; i++) {
			console.log('TCBA ' + options.translation(arg));
			if (options.polledReadBlockList[i].addr === options.translation(arg)) {
				console.log('Splicing');
				options.polledReadBlockList.splice(i, 1);
			}
		}
	} else if (Array.isArray(arg)) {
		for (i = 0; i < options.polledReadBlockList.length; i++) {
			for (var j = 0; j < arg.length; j++) {
				if (options.polledReadBlockList[i].addr === options.translation(arg[j])) {
					options.polledReadBlockList.splice(i, 1);
				}
			}
		}
	}
	options.readPacketValid = false;
	//	options.prepareReadPacket();
}

readAllItems = function(arg) {
	var self = this;

	console.log("Reading All Items (readAllItems was called)", 1, options.connectionID);

	if (typeof arg === "function") {
		options.readSuccess = arg;
	} else {
		options.readSuccess = doNothing;
	}

	if (options.isoConnectionState !== 4) {
		console.log("Unable to read when not connected. Return bad values.", 0, options.connectionID);
	} // For better behaviour when auto-reconnecting - don't return now

	// Check if ALL are done...  You might think we could look at parallel jobs, and for the most part we can, but if one just finished and we end up here before starting another, it's bad.
	if (options.isWaiting()) {
		console.log("Waiting to read for all R/W operations to complete.  Will re-trigger readAllItems in 100ms.", 0, options.connectionID);
		setTimeout(function() {
			options.readAllItems.apply(self, arguments);
		}, 100, arg);
		return;
	}

	// Now we check the array of adding and removing things.  Only now is it really safe to do this.
	options.addRemoveArray.forEach(function(element) {
		console.log('Adding or Removing ' + util.format(element), 1, options.connectionID);
		if (element.action === 'remove') {
			options.removeItemsNow(element.arg);
		}
		if (element.action === 'add') {
			options.addItemsNow(element.arg);
		}
	});

	options.addRemoveArray = []; // Clear for next time.

	if (!options.readPacketValid) { options.prepareReadPacket(); }

	// ideally...  incrementSequenceNumbers();

	console.log("Calling SRP from RAI", 1, options.connectionID);
	options.sendReadPacket(); // Note this sends the first few read packets depending on parallel connection restrictions.
}

isWaiting = function() {
	var self = this;
	return (options.isReading() || options.isWriting());
}

isReading = function() {
	var self = this, i;
	// Walk through the array and if any packets are marked as sent, it means we haven't received our final confirmation.
	for (i = 0; i < options.readPacketArray.length; i++) {
		if (options.readPacketArray[i].sent === true) { return true }
	}
	return false;
}

isWriting = function() {
	var self = this, i;
	// Walk through the array and if any packets are marked as sent, it means we haven't received our final confirmation.
	for (i = 0; i < options.writePacketArray.length; i++) {
		if (options.writePacketArray[i].sent === true) { return true }
	}
	return false;
}


function clearReadPacketTimeouts() {
	var self = this, i;
	console.log('Clearing read PacketTimeouts', 1, options.connectionID);
	// Before we initialize the options.readPacketArray, we need to loop through all of them and clear timeouts.
	for (i = 0; i < options.readPacketArray.length; i++) {
		clearTimeout(options.readPacketArray[i].timeout);
		options.readPacketArray[i].sent = false;
		options.readPacketArray[i].rcvd = false;
	}
}

function clearWritePacketTimeouts() {
	var self = this, i;
	console.log('Clearing write PacketTimeouts', 1, options.connectionID);
	// Before we initialize the options.readPacketArray, we need to loop through all of them and clear timeouts.
	for (i = 0; i < options.writePacketArray.length; i++) {
		clearTimeout(options.writePacketArray[i].timeout);
		options.writePacketArray[i].sent = false;
		options.writePacketArray[i].rcvd = false;
	}
}

prepareWritePacket = function() {
	var self = this, i;
	var itemList = options.instantWriteBlockList;
	var requestList = [];			// The request list consists of the block list, split into chunks readable by PDU.
	var requestNumber = 0;

	// Sort the items using the sort function, by type and offset.
	itemList.sort(itemListSorter);

	// Just exit if there are no items.
	if (itemList.length === 0) {
		return undefined;
	}

	// Reinitialize the WriteBlockList
	options.globalWriteBlockList = [];

	// At this time we do not do write optimizations.
	// The reason for this is it is would cause numerous issues depending how the code was written in the PLC.
	// If we write M0.1 and M0.2 then to optimize we would have to write MB0, which also writes 0.0, 0.3, 0.4...
	//
	// I suppose when working with integers, if we write MW0 and MW2, we could write these as one block.
	// But if you really, really want the program to do that, write an array youroptions.
	options.globalWriteBlockList[0] = itemList[0];
	options.globalWriteBlockList[0].itemReference = [];
	options.globalWriteBlockList[0].itemReference.push(itemList[0]);

	var thisBlock = 0;
	itemList[0].block = thisBlock;
	var maxByteRequest = 4 * Math.floor((options.maxPDU - 18 - 12) / 4);  // Absolutely must not break a real array into two requests.  Maybe we can extend by two bytes when not DINT/REAL/INT.
	//	console.log("Max Write Length is " + maxByteRequest);

	// Just push the items into blocks and figure out the write buffers
	for (i = 0; i < itemList.length; i++) {
		options.globalWriteBlockList[i] = itemList[i]; // Remember - by reference.
		options.globalWriteBlockList[i].isOptimized = false;
		options.globalWriteBlockList[i].itemReference = [];
		options.globalWriteBlockList[i].itemReference.push(itemList[i]);
		bufferizeS7Item(itemList[i]);
	}

	var thisRequest = 0;

	// Split the blocks into requests, if they're too large.
	for (i = 0; i < options.globalWriteBlockList.length; i++) {
		var startByte = options.globalWriteBlockList[i].offset;
		var remainingLength = options.globalWriteBlockList[i].byteLength;
		var lengthOffset = 0;

		// Always create a request for a options.globalReadBlockList.
		requestList[thisRequest] = options.globalWriteBlockList[i].clone();

		// How many parts?
		options.globalWriteBlockList[i].parts = Math.ceil(options.globalWriteBlockList[i].byteLength / maxByteRequest);
		//		console.log("options.globalWriteBlockList " + i + " parts is " + options.globalWriteBlockList[i].parts + " offset is " + options.globalWriteBlockList[i].offset + " MBR is " + maxByteRequest);

		options.globalWriteBlockList[i].requestReference = [];

		// If we're optimized...
		for (var j = 0; j < options.globalWriteBlockList[i].parts; j++) {
			requestList[thisRequest] = options.globalWriteBlockList[i].clone();
			options.globalWriteBlockList[i].requestReference.push(requestList[thisRequest]);
			requestList[thisRequest].offset = startByte;
			requestList[thisRequest].byteLength = Math.min(maxByteRequest, remainingLength);
			requestList[thisRequest].byteLengthWithFill = requestList[thisRequest].byteLength;
			if (requestList[thisRequest].byteLengthWithFill % 2) { requestList[thisRequest].byteLengthWithFill += 1; }

			// max

			requestList[thisRequest].writeBuffer = options.globalWriteBlockList[i].writeBuffer.slice(lengthOffset, lengthOffset + requestList[thisRequest].byteLengthWithFill);
			requestList[thisRequest].writeQualityBuffer = options.globalWriteBlockList[i].writeQualityBuffer.slice(lengthOffset, lengthOffset + requestList[thisRequest].byteLengthWithFill);
			lengthOffset += options.globalWriteBlockList[i].requestReference[j].byteLength;

			if (options.globalWriteBlockList[i].parts > 1) {
				requestList[thisRequest].datatype = 'BYTE';
				requestList[thisRequest].dtypelen = 1;
				requestList[thisRequest].arrayLength = requestList[thisRequest].byteLength;//options.globalReadBlockList[thisBlock].byteLength;		(This line shouldn't be needed anymore - shouldn't matter)
			}
			remainingLength -= maxByteRequest;
			thisRequest++;
			startByte += maxByteRequest;
		}
	}

	clearWritePacketTimeouts();
	options.writePacketArray = [];

	//	console.log("GWBL is " + options.globalWriteBlockList.length);


	// Before we initialize the options.writePacketArray, we need to loop through all of them and clear timeouts.

	// The packetizer...
	while (requestNumber < requestList.length) {
		// Set up the read packet
		// Yes this is the same master sequence number shared with the read queue
		options.masterSequenceNumber += 1;
		if (options.masterSequenceNumber > 32767) {
			options.masterSequenceNumber = 1;
		}

		var numItems = 0;

		// Maybe this shouldn't really be here?
		options.writeReqHeader.copy(options.writeReq, 0);

		// Packet's length
		var packetWriteLength = 10 + 4;  // 10 byte header and 4 byte param header

		options.writePacketArray.push(new S7Packet());
		var thisPacketNumber = options.writePacketArray.length - 1;
		options.writePacketArray[thisPacketNumber].seqNum = options.masterSequenceNumber;
		//		console.log("Write Sequence Number is " + options.writePacketArray[thisPacketNumber].seqNum);

		options.writePacketArray[thisPacketNumber].itemList = [];  // Initialize as array.

		for (i = requestNumber; i < requestList.length; i++) {
			//console.log("Number is " + (requestList[i].byteLengthWithFill + 4 + packetReplyLength));
			if (requestList[i].byteLengthWithFill + 12 + 4 + packetWriteLength > options.maxPDU) { // 12 byte header for each item and 4 bytes for the data header
				if (numItems === 0) {
					console.log("breaking when we shouldn't, byte length with fill is  " + requestList[i].byteLengthWithFill + " max byte request " + maxByteRequest, 0, options.connectionID);
					throw new Error("Somehow write request didn't split properly - exiting.  Report this as a bug.");
				}
				break;  // We can't fit this packet in here.
			}
			requestNumber++;
			numItems++;
			packetWriteLength += (requestList[i].byteLengthWithFill + 12 + 4); // Don't forget each request has a 12 byte header as well.
			//console.log('I is ' + i + ' Addr Type is ' + requestList[i].addrtype + ' and type is ' + requestList[i].datatype + ' and DBNO is ' + requestList[i].dbNumber + ' and offset is ' + requestList[i].offset + ' bit ' + requestList[i].bitOffset + ' len ' + requestList[i].arrayLength);
			//S7AddrToBuffer(requestList[i]).copy(options.writeReq, 19 + numItems * 12);  // i or numItems?  used to be i.
			//itemBuffer = bufferizeS7Packet(requestList[i]);
			//itemBuffer.copy(dataBuffer, dataBufferPointer);
			//dataBufferPointer += itemBuffer.length;
			options.writePacketArray[thisPacketNumber].itemList.push(requestList[i]);
		}
		//		dataBuffer.copy(options.writeReq, 19 + (numItems + 1) * 12, 0, dataBufferPointer - 1);
	}
}


prepareReadPacket = function() {
	var self = this, i;
	// Note that for a PDU size of 240, the MOST bytes we can request depends on the number of items.
	// To figure this out, allow for a 247 byte packet.  7 TPKT+COTP header doesn't count for PDU, so 240 bytes of "S7 data".
	// In the response you ALWAYS have a 12 byte S7 header.
	// Then you have a 2 byte parameter header.
	// Then you have a 4 byte "item header" PER ITEM.
	// So you have overhead of 18 bytes for one item, 22 bytes for two items, 26 bytes for 3 and so on.  So for example you can request 240 - 22 = 218 bytes for two items.

	// We can calculate a max byte length for single request as 4*Math.floor((options.maxPDU - 18)/4) - to ensure we don't cross boundaries.

	var itemList = options.polledReadBlockList;				// The items are the actual items requested by the user
	var requestList = [];						// The request list consists of the block list, split into chunks readable by PDU.

	// Validity check.
	for (i = itemList.length - 1; i >= 0; i--) {
		if (itemList[i] === undefined) {
			itemList.splice(i, 1);
			console.log("Dropping an undefined request item.", 0, options.connectionID);
		}
	}

	// Sort the items using the sort function, by type and offset.
	itemList.sort(itemListSorter);

	// Just exit if there are no items.
	if (itemList.length === 0) {
		return undefined;
	}

	options.globalReadBlockList = [];

	// ...because you have to start your optimization somewhere.
	options.globalReadBlockList[0] = itemList[0];
	options.globalReadBlockList[0].itemReference = [];
	options.globalReadBlockList[0].itemReference.push(itemList[0]);

	var thisBlock = 0;
	itemList[0].block = thisBlock;
	var maxByteRequest = 4 * Math.floor((options.maxPDU - 18) / 4);  // Absolutely must not break a real array into two requests.  Maybe we can extend by two bytes when not DINT/REAL/INT.

	// Optimize the items into blocks
	for (i = 1; i < itemList.length; i++) {
		// Skip T, C, P types
		if ((itemList[i].areaS7Code !== options.globalReadBlockList[thisBlock].areaS7Code) ||   	// Can't optimize between areas
			(itemList[i].dbNumber !== options.globalReadBlockList[thisBlock].dbNumber) ||			// Can't optimize across DBs
			(!options.isOptimizableArea(itemList[i].areaS7Code)) || 					// Can't optimize T,C (I don't think) and definitely not P.
			((itemList[i].offset - options.globalReadBlockList[thisBlock].offset + itemList[i].byteLength) > maxByteRequest) ||      	// If this request puts us over our max byte length, create a new block for consistency reasons.
			(itemList[i].offset - (options.globalReadBlockList[thisBlock].offset + options.globalReadBlockList[thisBlock].byteLength) > options.maxGap)) {		// If our gap is large, create a new block.
			// At this point we give up and create a new block.
			thisBlock = thisBlock + 1;
			options.globalReadBlockList[thisBlock] = itemList[i]; // By reference.
			//				itemList[i].block = thisBlock; // Don't need to do this.
			options.globalReadBlockList[thisBlock].isOptimized = false;
			options.globalReadBlockList[thisBlock].itemReference = [];
			options.globalReadBlockList[thisBlock].itemReference.push(itemList[i]);
		} else {
			console.log("Attempting optimization of item " + itemList[i].addr + " with " + options.globalReadBlockList[thisBlock].addr, 0, options.connectionID);
			// This next line checks the maximum.
			// Think of this situation - we have a large request of 40 bytes starting at byte 10.
			//	Then someone else wants one byte starting at byte 12.  The block length doesn't change.
			//
			// But if we had 40 bytes starting at byte 10 (which gives us byte 10-49) and we want byte 50, our byte length is 50-10 + 1 = 41.
			options.globalReadBlockList[thisBlock].byteLength = Math.max(options.globalReadBlockList[thisBlock].byteLength, itemList[i].offset - options.globalReadBlockList[thisBlock].offset + itemList[i].byteLength);

			// Point the buffers (byte and quality) to a sliced version of the optimized block.  This is by reference (same area of memory)
			itemList[i].byteBuffer = options.globalReadBlockList[thisBlock].byteBuffer.slice(itemList[i].offset - options.globalReadBlockList[thisBlock].offset, itemList[i].offset - options.globalReadBlockList[thisBlock].offset + itemList[i].byteLength);
			itemList[i].qualityBuffer = options.globalReadBlockList[thisBlock].qualityBuffer.slice(itemList[i].offset - options.globalReadBlockList[thisBlock].offset, itemList[i].offset - options.globalReadBlockList[thisBlock].offset + itemList[i].byteLength);

			// For now, change the request type here, and fill in some other things.

			// I am not sure we want to do these next two steps.
			// It seems like things get screwed up when we do this.
			// Since options.globalReadBlockList[thisBlock] exists already at this point, and our buffer is already set, let's not do this now.
			// options.globalReadBlockList[thisBlock].datatype = 'BYTE';
			// options.globalReadBlockList[thisBlock].dtypelen = 1;
			options.globalReadBlockList[thisBlock].isOptimized = true;
			options.globalReadBlockList[thisBlock].itemReference.push(itemList[i]);
		}
	}

	var thisRequest = 0;

	//	console.log("Preparing the read packet...");

	// Split the blocks into requests, if they're too large.
	for (i = 0; i < options.globalReadBlockList.length; i++) {
		// Always create a request for a options.globalReadBlockList.
		requestList[thisRequest] = options.globalReadBlockList[i].clone();

		// How many parts?
		options.globalReadBlockList[i].parts = Math.ceil(options.globalReadBlockList[i].byteLength / maxByteRequest);
		console.log("options.globalReadBlockList " + i + " parts is " + options.globalReadBlockList[i].parts + " offset is " + options.globalReadBlockList[i].offset + " MBR is " + maxByteRequest, 1, options.connectionID);
		var startByte = options.globalReadBlockList[i].offset;
		var remainingLength = options.globalReadBlockList[i].byteLength;

		options.globalReadBlockList[i].requestReference = [];

		// If we're optimized...
		for (var j = 0; j < options.globalReadBlockList[i].parts; j++) {
			requestList[thisRequest] = options.globalReadBlockList[i].clone();
			options.globalReadBlockList[i].requestReference.push(requestList[thisRequest]);
			//console.log(options.globalReadBlockList[i]);
			//console.log(options.globalReadBlockList.slice(i,i+1));
			requestList[thisRequest].offset = startByte;
			requestList[thisRequest].byteLength = Math.min(maxByteRequest, remainingLength);
			requestList[thisRequest].byteLengthWithFill = requestList[thisRequest].byteLength;
			if (requestList[thisRequest].byteLengthWithFill % 2) { requestList[thisRequest].byteLengthWithFill += 1; }
			// Just for now...
			if (options.globalReadBlockList[i].parts > 1) {
				requestList[thisRequest].datatype = 'BYTE';
				requestList[thisRequest].dtypelen = 1;
				requestList[thisRequest].arrayLength = requestList[thisRequest].byteLength;//options.globalReadBlockList[thisBlock].byteLength;
			}
			remainingLength -= maxByteRequest;
			thisRequest++;
			startByte += maxByteRequest;
		}
	}

	//requestList[5].offset = 243;
	//	requestList = options.globalReadBlockList;

	// The packetizer...
	var requestNumber = 0;

	clearReadPacketTimeouts();
	options.readPacketArray = [];

	while (requestNumber < requestList.length) {
		// Set up the read packet
		options.masterSequenceNumber += 1;
		if (options.masterSequenceNumber > 32767) {
			options.masterSequenceNumber = 1;
		}

		var numItems = 0;
		options.readReqHeader.copy(options.readReq, 0);

		// Packet's expected reply length
		var packetReplyLength = 12 + 2;  //

		options.readPacketArray.push(new S7Packet());
		var thisPacketNumber = options.readPacketArray.length - 1;
		options.readPacketArray[thisPacketNumber].seqNum = options.masterSequenceNumber;
		console.log("Sequence Number is " + options.readPacketArray[thisPacketNumber].seqNum, 1, options.connectionID);

		options.readPacketArray[thisPacketNumber].itemList = [];  // Initialize as array.

		for (i = requestNumber; i < requestList.length; i++) {
			//console.log("Number is " + (requestList[i].byteLengthWithFill + 4 + packetReplyLength));
			if (requestList[i].byteLengthWithFill + 4 + packetReplyLength > options.maxPDU) {
				if (numItems === 0) {
					console.log("breaking when we shouldn't, rlibl " + requestList[i].byteLengthWithFill + " MBR " + maxByteRequest, 0, options.connectionID);
					throw new Error("Somehow write request didn't split properly - exiting.  Report this as a bug.");
				}
				break;  // We can't fit this packet in here.
			}
			requestNumber++;
			numItems++;
			packetReplyLength += (requestList[i].byteLengthWithFill + 4);
			//console.log('I is ' + i + ' Addr Type is ' + requestList[i].addrtype + ' and type is ' + requestList[i].datatype + ' and DBNO is ' + requestList[i].dbNumber + ' and offset is ' + requestList[i].offset + ' bit ' + requestList[i].bitOffset + ' len ' + requestList[i].arrayLength);
			// skip this for now S7AddrToBuffer(requestList[i]).copy(options.readReq, 19 + numItems * 12);  // i or numItems?
			options.readPacketArray[thisPacketNumber].itemList.push(requestList[i]);
		}
	}
	options.readPacketValid = true;
}

sendReadPacket = function() {
	var self = this, i, j, flagReconnect = false;

	console.log("SendReadPacket called", 1, options.connectionID);

	for (i = 0; i < options.readPacketArray.length; i++) {
		if (options.readPacketArray[i].sent) { continue; }
		if (options.parallelJobsNow >= options.maxParallel) { continue; }
		// From here down is SENDING the packet
		options.readPacketArray[i].reqTime = process.hrtime();
		options.readReq.writeUInt8(options.readPacketArray[i].itemList.length, 18);
		options.readReq.writeUInt16BE(19 + options.readPacketArray[i].itemList.length * 12, 2); // buffer length
		options.readReq.writeUInt16BE(options.readPacketArray[i].seqNum, 11);
		options.readReq.writeUInt16BE(options.readPacketArray[i].itemList.length * 12 + 2, 13); // Parameter length - 14 for one read, 28 for 2.

		for (j = 0; j < options.readPacketArray[i].itemList.length; j++) {
			S7AddrToBuffer(options.readPacketArray[i].itemList[j], false).copy(options.readReq, 19 + j * 12);
		}

		if (options.isoConnectionState == 4) {
			options.readPacketArray[i].timeout = setTimeout(function() {
				options.packetTimeout.apply(self, arguments);
			}, options.globalTimeout, "read", options.readPacketArray[i].seqNum);
			options.isoclient.write(options.readReq.slice(0, 19 + options.readPacketArray[i].itemList.length * 12));  // was 31
			options.readPacketArray[i].sent = true;
			options.readPacketArray[i].rcvd = false;
			options.readPacketArray[i].timeoutError = false;
			options.parallelJobsNow += 1;
		} else {
			//			console.log('Somehow got into read block without proper options.isoConnectionState of 3.  Disconnect.');
			//			options.isoclient.end();
			//			setTimeout(function(){
			//				connectNow.apply(self, arguments);
			//			}, 2000, options.connectionParams);
			options.readPacketArray[i].sent = true;
			options.readPacketArray[i].rcvd = false;
			options.readPacketArray[i].timeoutError = true;
			if (!flagReconnect) {
				// Prevent duplicates
				console.log('Not Sending Read Packet because we are not connected - ISO CS is ' + options.isoConnectionState, 0, options.connectionID);
			}
			// This is essentially an instantTimeout.
			if (options.isoConnectionState === 0) {
				flagReconnect = true;
			}
			console.log('Requesting PacketTimeout Due to ISO CS NOT 4 - READ SN ' + options.readPacketArray[i].seqNum, 1, options.connectionID);
			options.readPacketArray[i].timeout = setTimeout(function() {
				options.packetTimeout.apply(self, arguments);
			}, 0, "read", options.readPacketArray[i].seqNum);
		}
		console.log('Sending Read Packet', 1, options.connectionID);
	}

	if (flagReconnect) {
		//		console.log("Asking for callback next tick and my ID is " + options.connectionID);
		setTimeout(function() {
			//			console.log("Next tick is here and my ID is " + options.connectionID);
			console.log("The scheduled reconnect from sendReadPacket is happening now", 1, options.connectionID);
			connectNow(options.connectionParams);  // We used to do this NOW - not NextTick() as we need to mark isoConnectionState as 1 right now.  Otherwise we queue up LOTS of connects and crash.
		}, 0);
	}


}


sendWritePacket = function() {
	var self = this, i, dataBuffer, itemBuffer, dataBufferPointer, flagReconnect;

	dataBuffer = new Buffer(8192);

	options.writeInQueue = false;

	for (i = 0; i < options.writePacketArray.length; i++) {
		if (options.writePacketArray[i].sent) { continue; }
		if (options.parallelJobsNow >= options.maxParallel) { continue; }
		// From here down is SENDING the packet
		options.writePacketArray[i].reqTime = process.hrtime();
		options.writeReq.writeUInt8(options.writePacketArray[i].itemList.length, 18);
		options.writeReq.writeUInt16BE(options.writePacketArray[i].seqNum, 11);

		dataBufferPointer = 0;
		for (var j = 0; j < options.writePacketArray[i].itemList.length; j++) {
			S7AddrToBuffer(options.writePacketArray[i].itemList[j], true).copy(options.writeReq, 19 + j * 12);
			itemBuffer = getWriteBuffer(options.writePacketArray[i].itemList[j]);
			itemBuffer.copy(dataBuffer, dataBufferPointer);
			dataBufferPointer += itemBuffer.length;
		}

		//		console.log('DataBufferPointer is ' + dataBufferPointer);
		options.writeReq.writeUInt16BE(19 + options.writePacketArray[i].itemList.length * 12 + dataBufferPointer, 2); // buffer length
		options.writeReq.writeUInt16BE(options.writePacketArray[i].itemList.length * 12 + 2, 13); // Parameter length - 14 for one read, 28 for 2.
		options.writeReq.writeUInt16BE(dataBufferPointer, 15); // Data length - as appropriate.

		dataBuffer.copy(options.writeReq, 19 + options.writePacketArray[i].itemList.length * 12, 0, dataBufferPointer);

		if (options.isoConnectionState === 4) {
			//			console.log('writing' + (19+dataBufferPointer+options.writePacketArray[i].itemList.length*12));
			options.writePacketArray[i].timeout = setTimeout(function() {
				options.packetTimeout.apply(self, arguments);
			}, options.globalTimeout, "write", options.writePacketArray[i].seqNum);
			options.isoclient.write(options.writeReq.slice(0, 19 + dataBufferPointer + options.writePacketArray[i].itemList.length * 12));  // was 31
			options.writePacketArray[i].sent = true;
			options.writePacketArray[i].rcvd = false;
			options.writePacketArray[i].timeoutError = false;
			options.parallelJobsNow += 1;
			console.log('Sending Write Packet With Sequence Number ' + options.writePacketArray[i].seqNum, 1, options.connectionID);
		} else {
			//			console.log('Somehow got into write block without proper isoConnectionState of 4.  Disconnect.');
			//			connectionReset();
			//			setTimeout(connectNow, 2000, connectionParams);
			// This is essentially an instantTimeout.
			options.writePacketArray[i].sent = true;
			options.writePacketArray[i].rcvd = false;
			options.writePacketArray[i].timeoutError = true;

			// Without the scopePlaceholder, this doesn't work.   writePacketArray[i] becomes undefined.
			// The reason is that the value i is part of a closure and when seen "nextTick" has the same value
			// it would have just after the FOR loop is done.
			// (The FOR statement will increment it to beyond the array, then exit after the condition fails)
			// scopePlaceholder works as the array is de-referenced NOW, not "nextTick".
			var scopePlaceholder = options.writePacketArray[i].seqNum;
			process.nextTick(function() {
				options.packetTimeout("write", scopePlaceholder);
			});
			if (options.isoConnectionState === 0) {
				flagReconnect = true;
			}
		}
	}
	if (flagReconnect) {
		//		console.log("Asking for callback next tick and my ID is " + options.connectionID);
		setTimeout(function() {
			//			console.log("Next tick is here and my ID is " + options.connectionID);
			console.log("The scheduled reconnect from sendWritePacket is happening now", 1, options.connectionID);
			connectNow(options.connectionParams);  // We used to do this NOW - not NextTick() as we need to mark isoConnectionState as 1 right now.  Otherwise we queue up LOTS of connects and crash.
		}, 0);
	}
}

isOptimizableArea = function(area) {
	var self = this;

	if (options.doNotOptimize) { return false; } // Are we skipping all optimization due to user request?
	switch (area) {
		case 0x84: // db
		case 0x81: // input bytes
		case 0x82: // output bytes
		case 0x83: // memory bytes
			return true;
		default:
			return false;
	}
}

onResponse = function(data) {
	var self = this;
	// Packet Validity Check.  Note that this will pass even with a "not available" response received from the server.
	// For length calculation and verification:
	// data[4] = COTP header length. Normally 2.  This doesn't include the length byte so add 1.
	// read(13) is parameter length.  Normally 4.
	// read(14) is data length.  (Includes item headers)
	// 12 is length of "S7 header"
	// Then we need to add 4 for TPKT header.

	// Decrement our parallel jobs now

	// NOT SO FAST - can't do this here.  If we time out, then later get the reply, we can't decrement this twice.  Or the CPU will not like us.  Do it if not rcvd.  options.parallelJobsNow--;

	if (data.length > 8 && data[8] != 3) {
		console.log('PDU type (byte 8) was returned as ' + data[8] + ' where the response PDU of 3 was expected.');
		console.log('Maybe you are requesting more than 240 bytes of data in a packet?');
		console.log(data);
		options.connectionReset();
		return null;
	}

	// The smallest read packet will pass a length check of 25.  For a 1-item write response with no data, length will be 22.
	if (data.length > data.readInt16BE(2)) {
		console.log("An oversize packet was detected.  Excess length is " + data.length - data.readInt16BE(2) + ".  ");
		console.log("We assume this is because two packets were sent at nearly the same time by the PLC.");
		console.log("We are slicing the buffer and scheduling the second half for further processing next loop.");
		setTimeout(function() {
			options.onResponse.apply(self, arguments);
		}, 0, data.slice(data.readInt16BE(2)));  // This re-triggers this same function with the sliced-up buffer.
		// was used as a test		setTimeout(process.exit, 2000);
	}

	if (data.length < data.readInt16BE(2) || data.readInt16BE(2) < 22 || data[5] !== 0xf0 || data[4] + 1 + 12 + 4 + data.readInt16BE(13) + data.readInt16BE(15) !== data.readInt16BE(2) || !(data[6] >> 7) || (data[7] !== 0x32) || (data[8] !== 3)) {
		console.log('INVALID READ RESPONSE - DISCONNECTING');
		console.log('TPKT Length From Header is ' + data.readInt16BE(2) + ' and RCV buffer length is ' + data.length + ' and COTP length is ' + data.readUInt8(4) + ' and data[6] is ' + data[6]);
		console.log(data);
		options.connectionReset();
		return null;
	}

	// Log the receive
	console.log('Received ' + data.readUInt16BE(15) + ' bytes of S7-data from PLC.  Sequence number is ' + data.readUInt16BE(11), 1, options.connectionID);

	// Check the sequence number
	var foundSeqNum; // options.readPacketArray.length - 1;
	var isReadResponse, isWriteResponse;

	//	for (packetCount = 0; packetCount < options.readPacketArray.length; packetCount++) {
	//		if (options.readPacketArray[packetCount].seqNum == data.readUInt16BE(11)) {
	//			foundSeqNum = packetCount;
	//			break;
	//		}
	//	}
	foundSeqNum = options.findReadIndexOfSeqNum(data.readUInt16BE(11));

	//	if (options.readPacketArray[packetCount] == undefined) {
	if (foundSeqNum === undefined) {
		foundSeqNum = options.findWriteIndexOfSeqNum(data.readUInt16BE(11));
		if (foundSeqNum !== undefined) {
			//		for (packetCount = 0; packetCount < options.writePacketArray.length; packetCount++) {
			//			if (options.writePacketArray[packetCount].seqNum == data.readUInt16BE(11)) {
			//				foundSeqNum = packetCount;
			options.writeResponse(data, foundSeqNum);
			isWriteResponse = true;
			//				break;
		}


	} else {
		isReadResponse = true;
		options.readResponse(data, foundSeqNum);
	}

	if ((!isReadResponse) && (!isWriteResponse)) {
		console.log("Sequence number that arrived wasn't a write reply either - dropping");
		console.log(data);
		// 	I guess this isn't a showstopper, just ignore it.
		//		options.isoclient.end();
		//		setTimeout(connectNow, 2000, options.connectionParams);
		return null;
	}
}

findReadIndexOfSeqNum = function(seqNum) {
	var self = this, packetCounter;
	for (packetCounter = 0; packetCounter < options.readPacketArray.length; packetCounter++) {
		if (options.readPacketArray[packetCounter].seqNum == seqNum) {
			return packetCounter;
		}
	}
	return undefined;
}

findWriteIndexOfSeqNum = function(seqNum) {
	var self = this, packetCounter;
	for (packetCounter = 0; packetCounter < options.writePacketArray.length; packetCounter++) {
		if (options.writePacketArray[packetCounter].seqNum == seqNum) {
			return packetCounter;
		}
	}
	return undefined;
}

writeResponse = function(data, foundSeqNum) {
	var self = this, dataPointer = 21, i, anyBadQualities;

	for (var itemCount = 0; itemCount < options.writePacketArray[foundSeqNum].itemList.length; itemCount++) {
		//		console.log('Pointer is ' + dataPointer);
		dataPointer = processS7WriteItem(data, options.writePacketArray[foundSeqNum].itemList[itemCount], dataPointer);
		if (!dataPointer) {
			console.log('Stopping Processing Write Response Packet due to unrecoverable packet error');
			break;
		}
	}

	// Make a note of the time it took the PLC to process the request.
	options.writePacketArray[foundSeqNum].reqTime = process.hrtime(options.writePacketArray[foundSeqNum].reqTime);
	console.log('Time is ' + options.writePacketArray[foundSeqNum].reqTime[0] + ' seconds and ' + Math.round(options.writePacketArray[foundSeqNum].reqTime[1] * 10 / 1e6) / 10 + ' ms.', 1, options.connectionID);

	//	options.writePacketArray.splice(foundSeqNum, 1);
	if (!options.writePacketArray[foundSeqNum].rcvd) {
		options.writePacketArray[foundSeqNum].rcvd = true;
		options.parallelJobsNow--;
	}
	clearTimeout(options.writePacketArray[foundSeqNum].timeout);

	if (!options.writePacketArray.every(doneSending)) {
		options.sendWritePacket();
	} else {
		for (i = 0; i < options.writePacketArray.length; i++) {
			options.writePacketArray[i].sent = false;
			options.writePacketArray[i].rcvd = false;
		}

		anyBadQualities = false;

		for (i = 0; i < options.globalWriteBlockList.length; i++) {
			// Post-process the write code and apply the quality.
			// Loop through the global block list...
			writePostProcess(options.globalWriteBlockList[i]);
			console.log(options.globalWriteBlockList[i].addr + ' write completed with quality ' + options.globalWriteBlockList[i].writeQuality, 1, options.connectionID);
			if (!isQualityOK(options.globalWriteBlockList[i].writeQuality)) { anyBadQualities = true; }
		}
		options.writeSuccess(anyBadQualities);
	}
}

function doneSending(element) {
	return ((element.sent && element.rcvd) ? true : false);
}

readResponse = function(data, foundSeqNum) {
	var self = this, i;
	var anyBadQualities;
	var dataPointer = 21; // For non-routed packets we start at byte 21 of the packet.  If we do routing it will be more than this.
	var dataObject = {};

	console.log("ReadResponse called", 1, options.connectionID);

	if (!options.readPacketArray[foundSeqNum].sent) {
		console.log('WARNING: Received a read response packet that was not marked as sent', 0, options.connectionID);
		//TODO - fix the network unreachable error that made us do this
		return null;
	}

	if (options.readPacketArray[foundSeqNum].rcvd) {
		console.log('WARNING: Received a read response packet that was already marked as received', 0, options.connectionID);
		return null;
	}

	for (var itemCount = 0; itemCount < options.readPacketArray[foundSeqNum].itemList.length; itemCount++) {
		dataPointer = processS7Packet(data, options.readPacketArray[foundSeqNum].itemList[itemCount], dataPointer);
		if (!dataPointer) {
			console.log('Received a ZERO RESPONSE Processing Read Packet due to unrecoverable packet error', 0, options.connectionID);
			// We rely on this for our timeout.
		}
	}

	// Make a note of the time it took the PLC to process the request.
	options.readPacketArray[foundSeqNum].reqTime = process.hrtime(options.readPacketArray[foundSeqNum].reqTime);
	console.log('Time is ' + options.readPacketArray[foundSeqNum].reqTime[0] + ' seconds and ' + Math.round(options.readPacketArray[foundSeqNum].reqTime[1] * 10 / 1e6) / 10 + ' ms.', 1, options.connectionID);

	// Do the bookkeeping for packet and timeout.
	if (!options.readPacketArray[foundSeqNum].rcvd) {
		options.readPacketArray[foundSeqNum].rcvd = true;
		options.parallelJobsNow--;
	}
	clearTimeout(options.readPacketArray[foundSeqNum].timeout);

	if (options.readPacketArray.every(doneSending)) {  // if sendReadPacket returns true we're all done.
		// Mark our packets unread for next time.
		for (i = 0; i < options.readPacketArray.length; i++) {
			options.readPacketArray[i].sent = false;
			options.readPacketArray[i].rcvd = false;
		}

		anyBadQualities = false;

		// Loop through the global block list...
		for (i = 0; i < options.globalReadBlockList.length; i++) {
			var lengthOffset = 0;
			// For each block, we loop through all the requests.  Remember, for all but large arrays, there will only be one.
			for (var j = 0; j < options.globalReadBlockList[i].requestReference.length; j++) {
				// Now that our request is complete, we reassemble the BLOCK byte buffer as a copy of each and every request byte buffer.
				options.globalReadBlockList[i].requestReference[j].byteBuffer.copy(options.globalReadBlockList[i].byteBuffer, lengthOffset, 0, options.globalReadBlockList[i].requestReference[j].byteLength);
				options.globalReadBlockList[i].requestReference[j].qualityBuffer.copy(options.globalReadBlockList[i].qualityBuffer, lengthOffset, 0, options.globalReadBlockList[i].requestReference[j].byteLength);
				lengthOffset += options.globalReadBlockList[i].requestReference[j].byteLength;
			}
			// For each ITEM reference pointed to by the block, we process the item.
			for (var k = 0; k < options.globalReadBlockList[i].itemReference.length; k++) {
				processS7ReadItem(options.globalReadBlockList[i].itemReference[k]);
				console.log('Address ' + options.globalReadBlockList[i].itemReference[k].addr + ' has value ' + options.globalReadBlockList[i].itemReference[k].value + ' and quality ' + options.globalReadBlockList[i].itemReference[k].quality, 1, options.connectionID);
				if (!isQualityOK(options.globalReadBlockList[i].itemReference[k].quality)) {
					anyBadQualities = true;
					dataObject[options.globalReadBlockList[i].itemReference[k].useraddr] = options.globalReadBlockList[i].itemReference[k].quality;
				} else {
					dataObject[options.globalReadBlockList[i].itemReference[k].useraddr] = options.globalReadBlockList[i].itemReference[k].value;
				}
			}
		}

		// Inform our user that we are done and that the values are ready for pickup.

		console.log("We are calling back our readSuccess.", 1, options.connectionID);
		if (typeof (options.readSuccess === 'function')) {
			options.readSuccess(anyBadQualities, dataObject);
		}
		if (options.resetPending) {
			options.resetNow();
		}

		if (!options.isReading() && options.writeInQueue) { options.sendWritePacket(); }
	} else {
		options.sendReadPacket();
	}
}


onClientDisconnect = function() {
	var self = this;
	console.log('ISO-on-TCP connection DISCONNECTED.', 0, options.connectionID);

	// We issue the callback here for Trela/Honcho - in some cases TCP connects, and ISO-on-TCP doesn't.
	// If this is the case we need to issue the Connect CB in order to keep trying.
	if ((!options.connectCBIssued) && (typeof (options.connected) === "function")) {
		options.connectCBIssued = true;
		options.connected("Error - TCP connected, ISO didn't");
	}

	// This event is called when the OTHER END of the connection sends a FIN packet.
	// Certain situations (download user program to mem card on S7-400, pop memory card out of S7-300, both with NetLink) cause this to happen.
	// So now, let's try a "connetionReset".  This way, we are guaranteed to return values (or bad) and reset at the proper time.
	options.connectionReset();
}

onClientClose = function() {
	var self = this;

    // clean up the connection now the socket has closed
	cleanup();

    // initiate the callback stored by dropConnection
    if (options.dropped) {
        options.dropped();

        // prevent any possiblity of the callback being called twice
        options.dropped = null;

        // and cancel the timeout
        clearTimeout(options.dropConnectionTimer);
    }
}

connectionReset = function() {
	var self = this;
	options.isoConnectionState = 0;
	options.resetPending = true;
	console.log('ConnectionReset is happening');
	if (!options.isReading() && typeof (options.resetTimeout) === 'undefined') { // For now - ignore writes.  && !isWriting()) {
		options.resetTimeout = setTimeout(function() {
			options.resetNow.apply(self, arguments);
		}, 1500);
	}
	// We wait until read() is called again to re-connect.
}

resetNow = function() {
	var self = this;
	options.isoConnectionState = 0;
	options.isoclient.end();
	console.log('ResetNOW is happening');
	options.resetPending = false;
	// In some cases, we can have a timeout scheduled for a reset, but we don't want to call it again in that case.
	// We only want to call a reset just as we are returning values.  Otherwise, we will get asked to read // more values and we will "break our promise" to always return something when asked.
	if (typeof (options.resetTimeout) !== 'undefined') {
		clearTimeout(options.resetTimeout);
		options.resetTimeout = undefined;
		console.log('Clearing an earlier scheduled reset');
	}
}

function cleanup() {
	var self = this;
	options.isoConnectionState = 0;
	console.log('Connection cleanup is happening');
	if (typeof (options.isoclient) !== "undefined") {
		options.isoclient.removeAllListeners('data');
		options.isoclient.removeAllListeners('error');
		options.isoclient.removeAllListeners('connect');
		options.isoclient.removeAllListeners('end');
        options.isoclient.removeAllListeners('close');
	}
	clearTimeout(options.connectTimeout);
	clearTimeout(options.PDUTimeout);
	clearReadPacketTimeouts();  // Note this clears timeouts.
	clearWritePacketTimeouts();  // Note this clears timeouts.
}

/**
 * Internal Functions
 */

function S7AddrToBuffer(addrinfo, isWriting) {
	var thisBitOffset = 0, theReq = new Buffer([0x12, 0x0a, 0x10, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00]);

	// First 3 bytes (0,1,2) is constant, sniffed from other traffic, for S7 head.
	// Next one is "byte length" - we always request X number of bytes - even for a REAL with length of 1 we read BYTES length of 4.
	theReq[3] = 0x02;  // Byte length

	// Next we write the number of bytes we are going to read.
	if (addrinfo.datatype === 'X') {
		theReq.writeUInt16BE(addrinfo.byteLength, 4);
		if (isWriting && addrinfo.arrayLength === 1) {
			// Byte length will be 1 already so no need to special case this.
			theReq[3] = 0x01;  // 1 = "BIT" length
			// We need to specify the bit offset in this case only.  Normally, when reading, we read the whole byte anyway and shift bits around.  Can't do this when writing only one bit.
			thisBitOffset = addrinfo.bitOffset;
		}
	} else if (addrinfo.datatype === 'TIMER' || addrinfo.datatype === 'COUNTER') {
		theReq.writeUInt16BE(1, 4);
		theReq.writeUInt8(addrinfo.areaS7Code, 3);
	} else {
		theReq.writeUInt16BE(addrinfo.byteLength, 4);
	}

	// Then we write the data block number.
	theReq.writeUInt16BE(addrinfo.dbNumber, 6);

	// Write our area crossing pointer.  When reading, write a bit offset of 0 - we shift the bit offset out later only when reading.
	theReq.writeUInt32BE(addrinfo.offset * 8 + thisBitOffset, 8);

	// Now we have to BITWISE OR the area code over the area crossing pointer.
	// This must be done AFTER writing the area crossing pointer as there is overlap, but this will only be noticed on large DB.
	theReq[8] |= addrinfo.areaS7Code;

	return theReq;
}

function processS7Packet(theData, theItem, thePointer) {
	var remainingLength;

	if (typeof (theData) === "undefined") {
		remainingLength = 0;
		console.log("Processing an undefined packet, likely due to timeout error");
	} else {
		remainingLength = theData.length - thePointer;  // Say if length is 39 and pointer is 35 we can access 35,36,37,38 = 4 bytes.
	}
	var prePointer = thePointer;

	// Create a new buffer for the quality.
	theItem.qualityBuffer = new Buffer(theItem.byteLength);
	theItem.qualityBuffer.fill(0xFF);  // Fill with 0xFF (255) which means NO QUALITY in the OPC world.

	if (remainingLength < 4) {
		theItem.valid = false;
		if (typeof (theData) !== "undefined") {
			theItem.errCode = 'Malformed Packet - Less Than 4 Bytes.  TDL' + theData.length + 'TP' + thePointer + 'RL' + remainingLength;
		} else {
			theItem.errCode = "Timeout error - zero length packet";
		}
		console.log(theItem.errCode);
		return 0;   			// Hard to increment the pointer so we call it a malformed packet and we're done.
	}

	var reportedDataLength;

	if (theItem.readTransportCode == 0x04) {
		reportedDataLength = theData.readUInt16BE(thePointer + 2) / 8;  // For different transport codes this may not be right.
	} else {
		reportedDataLength = theData.readUInt16BE(thePointer + 2);
	}
	var responseCode = theData[thePointer];
	var transportCode = theData[thePointer + 1];

	if (remainingLength == (reportedDataLength + 2)) {
		console.log("Not last part.");
	}

	if (remainingLength < reportedDataLength + 2) {
		theItem.valid = false;
		theItem.errCode = 'Malformed Packet - Item Data Length and Packet Length Disagree.  RDL+2 ' + (reportedDataLength + 2) + ' remainingLength ' + remainingLength;
		console.log(theItem.errCode);
		return 0;   			// Hard to increment the pointer so we call it a malformed packet and we're done.
	}

	if (responseCode !== 0xff) {
		theItem.valid = false;
		theItem.errCode = 'Invalid Response Code - ' + responseCode;
		console.log(theItem.errCode);
		return thePointer + reportedDataLength + 4;
	}

	if (transportCode !== theItem.readTransportCode) {
		theItem.valid = false;
		theItem.errCode = 'Invalid Transport Code - ' + transportCode;
		console.log(theItem.errCode);
		return thePointer + reportedDataLength + 4;
	}

	var expectedLength = theItem.byteLength;

	if (reportedDataLength !== expectedLength) {
		theItem.valid = false;
		theItem.errCode = 'Invalid Response Length - Expected ' + expectedLength + ' but got ' + reportedDataLength + ' bytes.';
		console.log(theItem.errCode);
		return reportedDataLength + 2;
	}

	// Looks good so far.
	// Increment our data pointer past the status code, transport code and 2 byte length.
	thePointer += 4;

	theItem.valid = true;
	theItem.byteBuffer = theData.slice(thePointer, thePointer + reportedDataLength);
	theItem.qualityBuffer.fill(0xC0);  // Fill with 0xC0 (192) which means GOOD QUALITY in the OPC world.

	thePointer += theItem.byteLength; //WithFill;

	if (((thePointer - prePointer) % 2)) { // Odd number.  With the S7 protocol we only request an even number of bytes.  So there will be a filler byte.
		thePointer += 1;
	}

	//	console.log("We have an item value of " + theItem.value + " for " + theItem.addr + " and pointer of " + thePointer);

	return thePointer;
}

function processS7WriteItem(theData, theItem, thePointer) {
	var remainingLength;

	if (!theData) {
		theItem.writeQualityBuffer.fill(0xFF);  // Note that ff is good in the S7 world but BAD in our fill here.
		theItem.valid = false;
		theItem.errCode = 'We must have timed Out - we have no response to process';
		console.log(theItem.errCode);
		return 0;
	}

	remainingLength = theData.length - thePointer;  // Say if length is 39 and pointer is 35 we can access 35,36,37,38 = 4 bytes.

	if (remainingLength < 1) {
		theItem.writeQualityBuffer.fill(0xFF);  // Note that ff is good in the S7 world but BAD in our fill here.
		theItem.valid = false;
		theItem.errCode = 'Malformed Packet - Less Than 1 Byte.  TDL ' + theData.length + ' TP' + thePointer + ' RL' + remainingLength;
		console.log(theItem.errCode);
		return 0;   			// Hard to increment the pointer so we call it a malformed packet and we're done.
	}

	var writeResponse = theData.readUInt8(thePointer);

	theItem.writeResponse = writeResponse;

	if (writeResponse !== 0xff) {
		console.log('Received write error of ' + theItem.writeResponse + ' on ' + theItem.addr);
		theItem.writeQualityBuffer.fill(0xFF);  // Note that ff is good in the S7 world but BAD in our fill here.
	} else {
		theItem.writeQualityBuffer.fill(0xC0);
	}

	return (thePointer + 1);
}

function writePostProcess(theItem) {
	var thePointer = 0;
	if (theItem.arrayLength === 1) {
		if (theItem.writeQualityBuffer[0] === 0xFF) {
			theItem.writeQuality = 'BAD';
		} else {
			theItem.writeQuality = 'OK';
		}
	} else {
		// Array value.
		theItem.writeQuality = [];
		for (var arrayIndex = 0; arrayIndex < theItem.arrayLength; arrayIndex++) {
			if (theItem.writeQualityBuffer[thePointer] === 0xFF) {
				theItem.writeQuality[arrayIndex] = 'BAD';
			} else {
				theItem.writeQuality[arrayIndex] = 'OK';
			}
			if (theItem.datatype == 'X') {
				// For bit arrays, we have to do some tricky math to get the pointer to equal the byte offset.
				// Note that we add the bit offset here for the rare case of an array starting at other than zero.  We either have to
				// drop support for this at the request level or support it here.

				if ((((arrayIndex + theItem.bitOffset + 1) % 8) === 0) || (arrayIndex == theItem.arrayLength - 1)) {
					thePointer += theItem.dtypelen;
				}
			} else {
				// Add to the pointer every time.
				thePointer += theItem.dtypelen;
			}
		}
	}
}


function processS7ReadItem(theItem) {
	var thePointer = 0;
	var strlen = 0;

	if (theItem.arrayLength > 1) {
		// Array value.
		if (theItem.datatype != 'C' && theItem.datatype != 'CHAR' && theItem.datatype != 'S' && theItem.datatype != 'STRING') {
			theItem.value = [];
			theItem.quality = [];
		} else {
			theItem.value = '';
			theItem.quality = '';
		}
		var bitShiftAmount = theItem.bitOffset;
		for (var arrayIndex = 0; arrayIndex < theItem.arrayLength; arrayIndex++) {
			if (theItem.qualityBuffer[thePointer] !== 0xC0) {
				if (theItem.quality instanceof Array) {
					theItem.value.push(theItem.badValue());
					theItem.quality.push('BAD ' + theItem.qualityBuffer[thePointer]);
				} else {
					theItem.value = theItem.badValue();
					theItem.quality = 'BAD ' + theItem.qualityBuffer[thePointer];
				}
			} else {
				// If we're a string, quality is not an array.
				if (theItem.quality instanceof Array) {
					theItem.quality.push('OK');
				} else {
					theItem.quality = 'OK';
				}
				switch (theItem.datatype) {

					case "REAL":
						theItem.value.push(theItem.byteBuffer.readFloatBE(thePointer));
						break;
					case "DWORD":
						theItem.value.push(theItem.byteBuffer.readUInt32BE(thePointer));
						break;
					case "DINT":
						theItem.value.push(theItem.byteBuffer.readInt32BE(thePointer));
						break;
					case "INT":
						theItem.value.push(theItem.byteBuffer.readInt16BE(thePointer));
						break;
					case "WORD":
						theItem.value.push(theItem.byteBuffer.readUInt16BE(thePointer));
						break;
					case "X":
						theItem.value.push(((theItem.byteBuffer.readUInt8(thePointer) >> (bitShiftAmount)) & 1) ? true : false);
						break;
					case "B":
					case "BYTE":
						theItem.value.push(theItem.byteBuffer.readUInt8(thePointer));
						break;
					case "S":
					case "STRING":
						if (arrayIndex === 1) {
							strlen = theItem.byteBuffer.readUInt8(thePointer);
						}
						if (arrayIndex > 1 && arrayIndex < (strlen + 2)) {  // say strlen = 1 (one-char string) this char is at arrayIndex of 2.
							// Convert to string.
							theItem.value += String.fromCharCode(theItem.byteBuffer.readUInt8(thePointer));
						}
						break;
					case "C":
					case "CHAR":
						// Convert to string.
						theItem.value += String.fromCharCode(theItem.byteBuffer.readUInt8(thePointer));
						break;
					case "TIMER":
					case "COUNTER":
						theItem.value.push(theItem.byteBuffer.readInt16BE(thePointer));
						break;

					default:
						console.log("Unknown data type in response - should never happen.  Should have been caught earlier.  " + theItem.datatype);
						return 0;
				}
			}
			if (theItem.datatype == 'X') {
				// For bit arrays, we have to do some tricky math to get the pointer to equal the byte offset.
				// Note that we add the bit offset here for the rare case of an array starting at other than zero.  We either have to
				// drop support for this at the request level or support it here.
				bitShiftAmount++;
				if ((((arrayIndex + theItem.bitOffset + 1) % 8) === 0) || (arrayIndex == theItem.arrayLength - 1)) {
					thePointer += theItem.dtypelen;
					bitShiftAmount = 0;
				}
			} else {
				// Add to the pointer every time.
				thePointer += theItem.dtypelen;
			}
		}
	} else {
		// Single value.
		if (theItem.qualityBuffer[thePointer] !== 0xC0) {
			theItem.value = theItem.badValue();
			theItem.quality = ('BAD ' + theItem.qualityBuffer[thePointer]);
		} else {
			theItem.quality = ('OK');
			switch (theItem.datatype) {

				case "REAL":
					theItem.value = theItem.byteBuffer.readFloatBE(thePointer);
					break;
				case "DWORD":
					theItem.value = theItem.byteBuffer.readUInt32BE(thePointer);
					break;
				case "DINT":
					theItem.value = theItem.byteBuffer.readInt32BE(thePointer);
					break;
				case "INT":
					theItem.value = theItem.byteBuffer.readInt16BE(thePointer);
					break;
				case "WORD":
					theItem.value = theItem.byteBuffer.readUInt16BE(thePointer);
					break;
				case "X":
					theItem.value = (((theItem.byteBuffer.readUInt8(thePointer) >> (theItem.bitOffset)) & 1) ? true : false);
					break;
				case "B":
				case "BYTE":
					// No support as of yet for signed 8 bit.  This isn't that common in Siemens.
					theItem.value = theItem.byteBuffer.readUInt8(thePointer);
					break;
				// No support for single strings.
				case "C":
				case "CHAR":
					// No support as of yet for signed 8 bit.  This isn't that common in Siemens.
					theItem.value = String.fromCharCode(theItem.byteBuffer.readUInt8(thePointer));
					break;
				case "TIMER":
				case "COUNTER":
					theItem.value = theItem.byteBuffer.readInt16BE(thePointer);
					break;
				default:
					console.log("Unknown data type in response - should never happen.  Should have been caught earlier.  " + theItem.datatype);
					return 0;
			}
		}
		thePointer += theItem.dtypelen;
	}

	if (((thePointer) % 2)) { // Odd number.  With the S7 protocol we only request an even number of bytes.  So there will be a filler byte.
		thePointer += 1;
	}

	//	console.log("We have an item value of " + theItem.value + " for " + theItem.addr + " and pointer of " + thePointer);
	return thePointer; // Should maybe return a value now???
}

function getWriteBuffer(theItem) {
	var newBuffer;

	if (theItem.datatype === 'X' && theItem.arrayLength === 1) {
		newBuffer = new Buffer(2 + 4);
		// Initialize, especially be sure to get last bit which may be a fill bit.
		newBuffer.fill(0);
		newBuffer.writeUInt16BE(1, 2); // Might need to do something different for different trans codes
	} else {
		newBuffer = new Buffer(theItem.byteLengthWithFill + 4);
		newBuffer.fill(0);
		newBuffer.writeUInt16BE(theItem.byteLength * 8, 2); // Might need to do something different for different trans codes
	}

	if (theItem.writeBuffer.length < theItem.byteLengthWithFill) {
		console.log("Attempted to access part of the write buffer that wasn't there when writing an item.");
	}

	newBuffer[0] = 0;
	newBuffer[1] = theItem.writeTransportCode;

	theItem.writeBuffer.copy(newBuffer, 4, 0, theItem.byteLength);  // Not with fill.  It might not be that long.

	return newBuffer;
}

function bufferizeS7Item(theItem) {
	var thePointer, theByte;
	theByte = 0;
	thePointer = 0; // After length and header

	if (theItem.arrayLength > 1) {
		// Array value.
		var bitShiftAmount = theItem.bitOffset;
		for (var arrayIndex = 0; arrayIndex < theItem.arrayLength; arrayIndex++) {
			switch (theItem.datatype) {
				case "REAL":
					theItem.writeBuffer.writeFloatBE(theItem.writeValue[arrayIndex], thePointer);
					break;
				case "DWORD":
					theItem.writeBuffer.writeInt32BE(theItem.writeValue[arrayIndex], thePointer);
					break;
				case "DINT":
					theItem.writeBuffer.writeInt32BE(theItem.writeValue[arrayIndex], thePointer);
					break;
				case "INT":
					theItem.writeBuffer.writeInt16BE(theItem.writeValue[arrayIndex], thePointer);
					break;
				case "WORD":
					theItem.writeBuffer.writeUInt16BE(theItem.writeValue[arrayIndex], thePointer);
					break;
				case "X":
					theByte = theByte | (((theItem.writeValue[arrayIndex] === true) ? 1 : 0) << bitShiftAmount);
					// Maybe not so efficient to do this every time when we only need to do it every 8.  Need to be careful with optimizations here for odd requests.
					theItem.writeBuffer.writeUInt8(theByte, thePointer);
					bitShiftAmount++;
					break;
				case "B":
				case "BYTE":
					theItem.writeBuffer.writeUInt8(theItem.writeValue[arrayIndex], thePointer);
					break;
				case "C":
				case "CHAR":
					// Convert to string.
					//??					theItem.writeBuffer.writeUInt8(theItem.writeValue.toCharCode(), thePointer);
					theItem.writeBuffer.writeUInt8(theItem.writeValue.charCodeAt(arrayIndex), thePointer);
					break;
				case "S":
				case "STRING":
					// Convert to string.
					if (arrayIndex === 0) {
						theItem.writeBuffer.writeUInt8(theItem.arrayLength - 2, thePointer); // Array length is requested val, -2 is string length
					} else if (arrayIndex === 1) {
						theItem.writeBuffer.writeUInt8(Math.min(theItem.arrayLength - 2, theItem.writeValue.length), thePointer);
					} else if (arrayIndex > 1 && arrayIndex < (theItem.writeValue.length + 2)) {
						theItem.writeBuffer.writeUInt8(theItem.writeValue.charCodeAt(arrayIndex - 2), thePointer);
					} else {
						theItem.writeBuffer.writeUInt8(32, thePointer); // write space
					}
					break;
				case "TIMER":
				case "COUNTER":
					// I didn't think we supported arrays of timers and counters.
					theItem.writeBuffer.writeInt16BE(theItem.writeValue[arrayIndex], thePointer);
					break;
				default:
					console.log("Unknown data type when preparing array write packet - should never happen.  Should have been caught earlier.  " + theItem.datatype);
					return 0;
			}
			if (theItem.datatype == 'X') {
				// For bit arrays, we have to do some tricky math to get the pointer to equal the byte offset.
				// Note that we add the bit offset here for the rare case of an array starting at other than zero.  We either have to
				// drop support for this at the request level or support it here.

				if ((((arrayIndex + theItem.bitOffset + 1) % 8) === 0) || (arrayIndex == theItem.arrayLength - 1)) {
					thePointer += theItem.dtypelen;
					bitShiftAmount = 0;
				}
			} else {
				// Add to the pointer every time.
				thePointer += theItem.dtypelen;
			}
		}
	} else {
		// Single value.
		switch (theItem.datatype) {

			case "REAL":
				theItem.writeBuffer.writeFloatBE(theItem.writeValue, thePointer);
				break;
			case "DWORD":
				theItem.writeBuffer.writeUInt32BE(theItem.writeValue, thePointer);
				break;
			case "DINT":
				theItem.writeBuffer.writeInt32BE(theItem.writeValue, thePointer);
				break;
			case "INT":
				theItem.writeBuffer.writeInt16BE(theItem.writeValue, thePointer);
				break;
			case "WORD":
				theItem.writeBuffer.writeUInt16BE(theItem.writeValue, thePointer);
				break;
			case "X":
				theItem.writeBuffer.writeUInt8(((theItem.writeValue === true) ? 1 : 0), thePointer);
				// not here				theItem.writeBuffer[1] = 1; // Set transport code to "BIT" to write a single bit.
				// not here				theItem.writeBuffer.writeUInt16BE(1, 2); // Write only one bit.
				break;
			case "B":
			case "BYTE":
				// No support as of yet for signed 8 bit.  This isn't that common in Siemens.
				theItem.writeBuffer.writeUInt8(theItem.writeValue, thePointer);
				break;
			case "C":
			case "CHAR":
				// No support as of yet for signed 8 bit.  This isn't that common in Siemens.
				theItem.writeBuffer.writeUInt8(String.toCharCode(theItem.writeValue), thePointer);
				break;
			case "TIMER":
			case "COUNTER":
				theItem.writeBuffer.writeInt16BE(theItem.writeValue, thePointer);
				break;
			default:
				console.log("Unknown data type in write prepare - should never happen.  Should have been caught earlier.  " + theItem.datatype);
				return 0;
		}
		thePointer += theItem.dtypelen;
	}
	return undefined;
}

function stringToS7Addr(addr, useraddr) {
	"use strict";
	var theItem, splitString, splitString2;

	if (useraddr === '_COMMERR') { return undefined; } // Special-case for communication error status - this variable returns true when there is a communications error

	theItem = new S7Item();
	splitString = addr.split(',');
	if (splitString.length === 0 || splitString.length > 2) {
		console.log("Error - String Couldn't Split Properly.");
		return undefined;
	}

	if (splitString.length > 1) { // Must be DB type
		theItem.addrtype = 'DB';  // Hard code
		splitString2 = splitString[1].split('.');
		theItem.datatype = splitString2[0].replace(/[0-9]/gi, '').toUpperCase(); // Clear the numbers
		if (theItem.datatype === 'X' && splitString2.length === 3) {
			theItem.arrayLength = parseInt(splitString2[2], 10);
		} else if (theItem.datatype !== 'X' && splitString2.length === 2) {
			theItem.arrayLength = parseInt(splitString2[1], 10);
		} else {
			theItem.arrayLength = 1;
		}
		if (theItem.arrayLength <= 0) {
			console.log('Zero length arrays not allowed, returning undefined');
			return undefined;
		}

		// Get the data block number from the first part.
		theItem.dbNumber = parseInt(splitString[0].replace(/[A-z]/gi, ''), 10);

		// Get the data block byte offset from the second part, eliminating characters.
		// Note that at this point, we may miss some info, like a "T" at the end indicating TIME data type or DATE data type or DT data type.  We ignore these.
		// This is on the TODO list.
		theItem.offset = parseInt(splitString2[0].replace(/[A-z]/gi, ''), 10);  // Get rid of characters

		// Get the bit offset
		if (splitString2.length > 1 && theItem.datatype === 'X') {
			theItem.bitOffset = parseInt(splitString2[1], 10);
			if (theItem.bitOffset > 7) {
				console.log("Invalid bit offset specified for address " + addr);
				return undefined;
			}
		}
	} else { // Must not be DB.  We know there's no comma.
		splitString2 = addr.split('.');

		switch (splitString2[0].replace(/[0-9]/gi, '')) {
			case "PAW":
			case "PIW":
			case "PEW":
			case "PQW":
				theItem.addrtype = "P";
				theItem.datatype = "INT";
				break;
			case "PAD":
			case "PID":
			case "PED":
			case "PQD":
				theItem.addrtype = "P";
				theItem.datatype = "DINT";
				break;
			case "PAB":
			case "PIB":
			case "PEB":
			case "PQB":
				theItem.addrtype = "P";
				theItem.datatype = "BYTE";
				break;
			case "IB":
			case "IC":
			case "EB":
			case "EC":
				theItem.addrtype = "I";
				theItem.datatype = "BYTE";
				break;
			case "IW":
			case "EW":
			case "II":
			case "EI":
				theItem.addrtype = "I";
				theItem.datatype = "INT";
				break;
			case "QW":
			case "AW":
			case "QI":
			case "AI":
				theItem.addrtype = "Q";
				theItem.datatype = "INT";
				break;
			case "MB":
			case "MC":
				theItem.addrtype = "M";
				theItem.datatype = "BYTE";
				break;
			case "M":
				theItem.addrtype = "M";
				theItem.datatype = "X";
				break;
			case "I":
			case "E":
				theItem.addrtype = "I";
				theItem.datatype = "X";
				break;
			case "Q":
			case "A":
				theItem.addrtype = "Q";
				theItem.datatype = "X";
				break;
			case "MW":
			case "MI":
				theItem.addrtype = "M";
				theItem.datatype = "INT";
				break;
			case "MDW":
			case "MDI":
			case "MD":
				theItem.addrtype = "M";
				theItem.datatype = "DINT";
				break;
			case "MR":
				theItem.addrtype = "M";
				theItem.datatype = "REAL";
				break;
			case "T":
				theItem.addrtype = "T";
				theItem.datatype = "TIMER";
				break;
			case "C":
				theItem.addrtype = "C";
				theItem.datatype = "COUNTER";
				break;
			default:
				console.log('Failed to find a match for ' + splitString2[0]);
				return undefined;
		}

		theItem.bitOffset = 0;
		if (splitString2.length > 1 && theItem.datatype === 'X') { // Bit and bit array
			theItem.bitOffset = parseInt(splitString2[1].replace(/[A-z]/gi, ''), 10);
			if (splitString2.length > 2) {  // Bit array only
				theItem.arrayLength = parseInt(splitString2[2].replace(/[A-z]/gi, ''), 10);
			} else {
				theItem.arrayLength = 1;
			}
		}
		if (splitString2.length > 1 && theItem.datatype !== 'X') { // Bit and bit array
			theItem.arrayLength = parseInt(splitString2[1].replace(/[A-z]/gi, ''), 10);
		} else {
			theItem.arrayLength = 1;
		}
		theItem.dbNumber = 0;
		theItem.offset = parseInt(splitString2[0].replace(/[A-z]/gi, ''), 10);
	}

	if (theItem.datatype === 'DI') {
		theItem.datatype = 'DINT';
	}
	if (theItem.datatype === 'I') {
		theItem.datatype = 'INT';
	}
	if (theItem.datatype === 'DW') {
		theItem.datatype = 'DWORD';
	}
	if (theItem.datatype === 'R') {
		theItem.datatype = 'REAL';
	}

	switch (theItem.datatype) {
		case "REAL":
		case "DWORD":
		case "DINT":
			theItem.dtypelen = 4;
			break;
		case "INT":
		case "WORD":
		case "TIMER":
		case "COUNTER":
			theItem.dtypelen = 2;
			break;
		case "X":
		case "B":
		case "C":
		case "BYTE":
		case "CHAR":
			theItem.dtypelen = 1;
			break;
		case "S":
		case "STRING":
			theItem.arrayLength += 2;
			theItem.dtypelen = 1;
			break;
		default:
			console.log("Unknown data type " + theItem.datatype);
			return undefined;
	}

	// Default
	theItem.readTransportCode = 0x04;

	switch (theItem.addrtype) {
		case "DB":
		case "DI":
			theItem.areaS7Code = 0x84;
			break;
		case "I":
		case "E":
			theItem.areaS7Code = 0x81;
			break;
		case "Q":
		case "A":
			theItem.areaS7Code = 0x82;
			break;
		case "M":
			theItem.areaS7Code = 0x83;
			break;
		case "P":
			theItem.areaS7Code = 0x80;
			break;
		case "C":
			theItem.areaS7Code = 0x1c;
			theItem.readTransportCode = 0x09;
			break;
		case "T":
			theItem.areaS7Code = 0x1d;
			theItem.readTransportCode = 0x09;
			break;
		default:
			console.log("Unknown memory area entered - " + theItem.addrtype);
			return undefined;
	}

	if (theItem.datatype === 'X' && theItem.arrayLength === 1) {
		theItem.writeTransportCode = 0x03;
	} else {
		theItem.writeTransportCode = theItem.readTransportCode;
	}

	// Save the address from the argument for later use and reference
	theItem.addr = addr;
	if (useraddr === undefined) {
		theItem.useraddr = addr;
	} else {
		theItem.useraddr = useraddr;
	}

	if (theItem.datatype === 'X') {
		theItem.byteLength = Math.ceil((theItem.bitOffset + theItem.arrayLength) / 8);
	} else {
		theItem.byteLength = theItem.arrayLength * theItem.dtypelen;
	}

	//	console.log(' Arr lenght is ' + theItem.arrayLength + ' and DTL is ' + theItem.dtypelen);

	theItem.byteLengthWithFill = theItem.byteLength;
	if (theItem.byteLengthWithFill % 2) { theItem.byteLengthWithFill += 1; }  // S7 will add a filler byte.  Use this expected reply length for PDU calculations.

	return theItem;
}

function S7Packet() {
	this.seqNum = undefined;				// Made-up sequence number to watch for.
	this.itemList = undefined;  			// This will be assigned the object that details what was in the request.
	this.reqTime = undefined;
	this.sent = false;						// Have we sent the packet yet?
	this.rcvd = false;						// Are we waiting on a reply?
	this.timeoutError = undefined;			// The packet is marked with error on timeout so we don't then later switch to good data.
	this.timeout = undefined;				// The timeout for use with clearTimeout()
}

function S7Item() { // Object
	// Save the original address
	this.addr = undefined;
	this.useraddr = undefined;

	// First group is properties to do with S7 - these alone define the address.
	this.addrtype = undefined;
	this.datatype = undefined;
	this.dbNumber = undefined;
	this.bitOffset = undefined;
	this.offset = undefined;
	this.arrayLength = undefined;

	// These next properties can be calculated from the above properties, and may be converted to functions.
	this.dtypelen = undefined;
	this.areaS7Code = undefined;
	this.byteLength = undefined;
	this.byteLengthWithFill = undefined;

	// Note that read transport codes and write transport codes will be the same except for bits which are read as bytes but written as bits
	this.readTransportCode = undefined;
	this.writeTransportCode = undefined;

	// This is where the data can go that arrives in the packet, before calculating the value.
	this.byteBuffer = new Buffer(8192);
	this.writeBuffer = new Buffer(8192);

	// We use the "quality buffer" to keep track of whether or not the requests were successful.
	// Otherwise, it is too easy to lose track of arrays that may only be partially complete.
	this.qualityBuffer = new Buffer(8192);
	this.writeQualityBuffer = new Buffer(8192);

	// Then we have item properties
	this.value = undefined;
	this.writeValue = undefined;
	this.valid = false;
	this.errCode = undefined;

	// Then we have result properties
	this.part = undefined;
	this.maxPart = undefined;

	// Block properties
	this.isOptimized = false;
	this.resultReference = undefined;
	this.itemReference = undefined;

	// And functions...
	this.clone = function() {
		var newObj = new S7Item();
		for (var i in this) {
			if (i == 'clone') continue;
			newObj[i] = this[i];
		} return newObj;
	};

	this.badValue = function() {
		switch (this.datatype) {
			case "REAL":
				return 0.0;
			case "DWORD":
			case "DINT":
			case "INT":
			case "WORD":
			case "B":
			case "BYTE":
			case "TIMER":
			case "COUNTER":
				return 0;
			case "X":
				return false;
			case "C":
			case "CHAR":
			case "S":
			case "STRING":
				// Convert to string.
				return "";
			default:
				console.log("Unknown data type when figuring out bad value - should never happen.  Should have been caught earlier.  " + this.datatype);
				return 0;
		}
	};
}

function itemListSorter(a, b) {
	// Feel free to manipulate these next two lines...
	if (a.areaS7Code < b.areaS7Code) { return -1; }
	if (a.areaS7Code > b.areaS7Code) { return 1; }

	// But for byte offset we need to start at 0.
	if (a.offset < b.offset) { return -1; }
	if (a.offset > b.offset) { return 1; }

	// Then bit offset
	if (a.bitOffset < b.bitOffset) { return -1; }
	if (a.bitOffset > b.bitOffset) { return 1; }

	// Then item length - most first.  This way smaller items are optimized into bigger ones if they have the same starting value.
	if (a.byteLength > b.byteLength) { return -1; }
	if (a.byteLength < b.byteLength) { return 1; }
}

function isQualityOK(obj) {
	if (typeof obj === "string") {
		if (obj !== 'OK') { return false; }
	} else if (Array.isArray(obj)) {
		for (var i = 0; i < obj.length; i++) {
			if (typeof obj[i] !== "string" || obj[i] !== 'OK') { return false; }
		}
	}
	return true;
}