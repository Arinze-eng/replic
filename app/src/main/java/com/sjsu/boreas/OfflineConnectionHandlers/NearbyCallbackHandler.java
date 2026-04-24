package com.sjsu.boreas.OfflineConnectionHandlers;

import android.os.AsyncTask;
import android.util.Base64;
import android.util.Log;

import androidx.annotation.NonNull;

import com.google.android.gms.nearby.connection.ConnectionInfo;
import com.google.android.gms.nearby.connection.ConnectionLifecycleCallback;
import com.google.android.gms.nearby.connection.ConnectionResolution;
import com.google.android.gms.nearby.connection.DiscoveredEndpointInfo;
import com.google.android.gms.nearby.connection.EndpointDiscoveryCallback;
import com.google.android.gms.nearby.connection.Payload;
import com.google.android.gms.nearby.connection.PayloadCallback;
import com.google.android.gms.nearby.connection.PayloadTransferUpdate;
import com.sjsu.boreas.Database.LocalDatabaseReference;
import com.sjsu.boreas.Database.NearByUsers.NearByUsers;
import com.sjsu.boreas.Events.Event;
import com.sjsu.boreas.Events.EventEmitter;
import com.sjsu.boreas.MainActivity;
import com.sjsu.boreas.Database.Messages.ChatMessage;
import com.sjsu.boreas.Database.Contacts.User;
import com.sjsu.boreas.Messages.AdjacencyListMessage;
import com.sjsu.boreas.Messages.LongDistanceMessage;
import com.sjsu.boreas.Messages.TextMessage;
import com.sjsu.boreas.OfflineConnectionHandlers.offline_messages.NeighborRequestMessage;

import java.io.ByteArrayInputStream;
import java.io.ByteArrayOutputStream;
import java.io.IOException;
import java.io.InputStream;
import java.io.ObjectInputStream;
import java.io.ObjectOutputStream;
import java.io.Serializable;
import java.security.KeyFactory;
import java.security.spec.PKCS8EncodedKeySpec;
import java.util.ArrayList;
import java.util.HashMap;
import java.util.HashSet;
import java.util.Iterator;
import java.util.LinkedList;
import java.util.List;
import java.util.concurrent.TimeUnit;

import javax.crypto.Cipher;

public class NearbyCallbackHandler implements EventEmitter {
    private final static String TAG = "BOREAS";
    private final static String SUB_TAG = "---NearbyCallbackHandler ";

    private NearbyConnectionHandler connectionHandler;
    private HashMap<String, String> connectedUsers; //Map endpointId to userId
    private HashMap<String, String> endPointNames;
    private LocalDatabaseReference localDatabaseReference = LocalDatabaseReference.get();
    public long NBRS_REQUEST_TTL = 25;
    Event event_neighbors = Event.get(Event.NBR_UPDATED);

    public NearbyCallbackHandler(NearbyConnectionHandler act){
        connectionHandler = act;
        connectedUsers = new HashMap<>();
        endPointNames = new HashMap<>();
    }

    //Receiving payloads
    public PayloadCallback payloadCallback = new PayloadCallback() {
        @Override
        public void onPayloadReceived(@NonNull final String endpointId, @NonNull Payload payload) {
            try {
                System.out.println(payload.getType());
                //ByteArrayInputStream bytes = new ByteArrayInputStream();
                ObjectInputStream stream = new ObjectInputStream(payload.asStream().asInputStream());
                Object result = stream.readObject();

                /*Parse message and find its type*/

                //Adjacency List
                //Don't connect if this device shares neighbors with the recipient to prevent graph from becoming too dense
                if(result instanceof AdjacencyListMessage){
                    AdjacencyListMessage message = (AdjacencyListMessage) result;
                    NearByUsers sender = new NearByUsers(message.sender.uid, message.sender.name, message.sender.latitude, message.sender.longitude, message.sender.publicKey);
                    localDatabaseReference.addNearByUser(sender);
                    //Check if received adjacency list overlaps current adjacency list
                    boolean isMeshMember = false;
                    HashSet<String> adjacencySet = createIdSet(connectionHandler.meshMembers);
                    for(String s : message.adjacentIds){
                        if(adjacencySet.contains(s)){
                            isMeshMember = true;
                            break;
                        }
                    }
                    if(isMeshMember){
                        connectionHandler.getClient().disconnectFromEndpoint(endpointId);
                        return;
                    }
                }


                //Local chat
                else if(result instanceof TextMessage){
                    Log.e(TAG, SUB_TAG+"Textmssg: " + result);
                    TextMessage message = (TextMessage) result;
                    connectionHandler.receiveMessage(message);

                    NearByUsers sender = new NearByUsers(message.sender.uid, message.sender.name, message.sender.latitude, message.sender.longitude, message.sender.publicKey);
                    NearByUsers forwarder = new NearByUsers(message.forwarder.uid, message.forwarder.name, message.forwarder.latitude, message.forwarder.longitude, message.forwarder.publicKey);

                    localDatabaseReference.addNearByUser(sender);
                    localDatabaseReference.addNearByUser(forwarder);

                    localDatabaseReference.saveChatMessageLocally(
                            new ChatMessage(MainActivity.currentUser, message.sender, "",
                                    message.message, message.timestamp, false, ChatMessage.ChatTypes.OFFLINEGROUPCHAT.getValue())
                    );
                }


                else if(result instanceof ChatMessage){
                    Log.e(TAG, SUB_TAG+"Chat message: " + result);
                    final ChatMessage message = (ChatMessage) result;

                    //Check if this message has already been forwarded by this user
                    if(message.isForwarder(MainActivity.currentUser.getUid())) {
                        Log.e(TAG, SUB_TAG+"u already gave this mssg yo");
                        return;
                    }

                    //Check if this is recipient
                    if(message.recipient.getUid().equals(MainActivity.currentUser.getUid())){
                        Log.e(TAG, SUB_TAG + "\t\tThe message is for me!!!!");
                        //Message has arrived at destination!
                        localDatabaseReference.saveChatMessageLocally(message);
                        return;
                    }
                    //If not, send to everyone except who sent it to you
                    //Decide who to forward it to based on distances to recipient
                    int forwardCount = 0;

                    NearByUsers recepient = new NearByUsers(message.recipient.uid, message.recipient.name, message.recipient.latitude, message.recipient.longitude, message.recipient.publicKey);
                    List<NearByUsers> nearestUsers = localDatabaseReference.getClosestNearByUsers(recepient);

                    message.addForwarder(MainActivity.currentUser.getUid());
                    for(User user : nearestUsers){
                        //Complete message forwarding once messages have been sent to at most 3 users
                        if(forwardCount >= 3)
                            break;
                        if(connectionHandler.neighbors.containsKey(user.uid)){
                            //Don't resend to person who sent this message here OR someone who has forwarded this message before
                            //First of above is subset of second, so only need to check second clause
                            if(!message.isForwarder(user.getUid())){
                                //Send message to user and increment
                                forwardCount++;
                                Payload forwardPayload = Payload.fromStream(constructStreamFromSerializable(message));
                                connectionHandler.getClient().sendPayload(connectionHandler.neighbors.get(user.uid), forwardPayload);
                            }
                        }
                    }

                }


                //Long distance chat message
                else if(result instanceof LongDistanceMessage){
                    LongDistanceMessage message = (LongDistanceMessage) result;

                    NearByUsers sender = new NearByUsers(message.sender.uid, message.sender.name, message.sender.latitude, message.sender.longitude, message.sender.publicKey);
                    NearByUsers recepient = new NearByUsers(message.recipient.uid, message.recipient.name, message.recipient.latitude, message.recipient.longitude, message.recipient.publicKey);
                    localDatabaseReference.addNearByUser(recepient);
                    localDatabaseReference.addNearByUser(sender);

                    NearByUsers forwarder = (NearByUsers) message.forwarder;
                    message.forwarder = MainActivity.currentUser;
                    //Decide who to forward it to based on distances to recipient
                    int forwardCount = 0;
                    List<NearByUsers> nearestUsers = localDatabaseReference.getClosestNearbyUsers(message);
                    for(NearByUsers user : nearestUsers){
                        //Complete message forwarding once messages have been sent to at most 3 users
                        if(forwardCount >= 3)
                            break;
                        if(connectionHandler.neighbors.containsKey(user.uid)){
                            if(user.uid != forwarder.uid){
                                //Send message to user and increment
                                forwardCount++;
                                Payload forwardPayload = Payload.fromStream(constructStreamFromSerializable(message));
                                connectionHandler.getClient().sendPayload(connectionHandler.neighbors.get(user.uid), forwardPayload);
                            }
                        }
                    }
                }

                //Sub-neighbor List
                else if(result instanceof NeighborRequestMessage){
                    Log.e(TAG, SUB_TAG+" processing NeighborRequestMessage response..");
                    // Event triggered here
                    if(connectionHandler.neighborsResponseTracker==0){
                        Log.e(TAG, SUB_TAG+" first response of a request");
                        event_neighbors.started(null);
                        connectionHandler.neighborsResponseTimer = System.nanoTime();
                    }

                    connectionHandler.neighborsResponseTracker += 1;

                    NeighborRequestMessage message = (NeighborRequestMessage) result;
                    // message.neighbor = our direct neighbor N
                    // message.subNeighbors = list of N's neighbors
                    // connectionHandler.subNeighbors = hasmap linking multiple [N -> N's neighbors]
//                    if(!connectionHandler.subNeighbors.containsKey(message.neighbor.uid)) {
//                        connectionHandler.subNeighbors.put(message.neighbor, new ArrayList<User>(){
//                            @Override
//                            public boolean add(User user) {
//                                if(!this.contains(user)) return super.add(user);
//                                else return false;
//                            }
//                        });
//                    }
//                    // checks if response neighbor is already in our list of subneighbors
//                    for(User subNeighbor : message.subNeighbors) {
//                        connectionHandler.subNeighbors.get(message.neighbor).add(subNeighbor);
//                        localDatabaseReference.addContact(subNeighbor);
//                    }
                    connectionHandler.subNeighbors.add(message.neighbor);
                    Log.e(TAG, SUB_TAG+" adding message neighbor: " + message.neighbor.name);
                    NearByUsers newNearByUser = new NearByUsers(message.neighbor.uid, message.neighbor.name, message.neighbor.latitude, message.neighbor.longitude, message.neighbor.publicKey);
                    localDatabaseReference.addNearByUser(newNearByUser);
                    for(User u : message.subNeighbors){
                        Log.e(TAG, SUB_TAG+" adding message sub-neighbor: " + u.name);
                        // can replace with addAll() but not sure if addAll() will use (overriden) add() or not
                        connectionHandler.subNeighbors.add(u);
                        newNearByUser = new NearByUsers(u.uid, u.name, u.latitude, u.longitude, u.publicKey);
                        localDatabaseReference.addNearByUser(newNearByUser);
                    }
                    Log.e(TAG, SUB_TAG+" added message.neighbor, and message.subneighbors");
                    HashMap<String, Object> eventPkt = new HashMap<>();
                    eventPkt.put("neighbors", connectionHandler.subNeighbors);
                    //check if all neighbors replied or NBRS_REQUEST_TTL have passed since request made (stale request)
                    // TODO: stale request responser should be handled too somehow?
                    if(connectionHandler.neighborsResponseTracker == connectionHandler.neighbors.size()
                        || TimeUnit.SECONDS.convert(connectionHandler.neighborsResponseTimer, TimeUnit.NANOSECONDS)>NBRS_REQUEST_TTL){
                        Log.e(TAG, SUB_TAG+" Detected last response/stale request");
                        connectionHandler.neighborsResponseTracker = 0;
                        event_neighbors.ended(eventPkt);
                    }
                    else event_neighbors.trigger(eventPkt);
                }

                //String Message
                else if(result instanceof String){
                    Log.e(TAG, SUB_TAG+"\t\tDumbass");
                    String message = (String) result;
                    //Request to get list of neighbors
                    if(message.equals(NearbyConnectionHandler.REQUEST_GET_NEIGHBORS)){
                        Log.e(TAG, SUB_TAG+" received request to send neighbors");
                        AsyncTask.execute(new Runnable() {
                            @Override
                            public void run() {
                                List<User> myNeighbors = new ArrayList<>();
                                for(String userId : connectionHandler.neighbors.keySet()) {//.values()
                                    Log.e(TAG, SUB_TAG+" adding neighbor: " + userId);

                                    //First check if the nearby user is in the nearbyusers table
                                    NearByUsers nearByUsers = localDatabaseReference.getNearByUserBasedOnId(userId);

                                    //If the user isn't in nearbyuser table then look at the contacts table
                                    if(nearByUsers == null){
                                        Log.e(TAG, SUB_TAG+"Couldn't find anythin in the nearby table, trying contacts");
                                        User user = localDatabaseReference.getUserById(userId);
                                        //Also save this user in the nearby table if not already saved
                                        if(user != null){
                                            NearByUsers newNearByUser = new NearByUsers(user.uid, user.name, user.latitude, user.longitude, user.publicKey);
                                            localDatabaseReference.addNearByUser(newNearByUser);
                                            myNeighbors.add(localDatabaseReference.getNearByUserBasedOnId(userId));
                                        }else
                                            Log.e(TAG, SUB_TAG+"!!!couldn't find anyone in contacts with that id");
                                    }
                                    else
                                        myNeighbors.add(localDatabaseReference.getNearByUserBasedOnId(userId));
                                }
                                NeighborRequestMessage response = new NeighborRequestMessage(MainActivity.currentUser, myNeighbors.toArray(new User[]{}));
                                Payload forwardPayload = Payload.fromStream(connectionHandler.getHandlerNearby().constructStreamFromSerializable(response));
                                connectionHandler.getClient().sendPayload(endpointId, forwardPayload);
                                Log.e(TAG, SUB_TAG+" sending response..");
                            }
                        });

                    }
                }
            }catch(Exception e){
                e.printStackTrace();
            }
        }

        @Override
        public void onPayloadTransferUpdate(@NonNull String endpointId, @NonNull PayloadTransferUpdate update) {
            //connectionHandler.receiveMessage(null, WifiConfiguration.Status.strings[update.getStatus()]);
        }
    };

    //Discovering other devices
    public EndpointDiscoveryCallback endpointDiscoveryCallback = new EndpointDiscoveryCallback() {
        @Override
        public void onEndpointFound(@NonNull String endpointId, @NonNull DiscoveredEndpointInfo discoveredEndpointInfo) {
            //Map endpointId to userId
            connectedUsers.put(endpointId, discoveredEndpointInfo.getEndpointName());
            MainActivity.makeLog("Network endpoint discovered, connecting to "+endpointId+"/"+discoveredEndpointInfo.getEndpointName());
            //connectionHandler.receiveMessage(null, "Network endpoint discovered, connecting to "+discoveredEndpointInfo.getEndpointName());
            connectionHandler.getClient().requestConnection(connectionHandler.getDeviceName(), endpointId, connectionLifecycleCallback);
            System.out.println("Found device!");
            Log.e(TAG, SUB_TAG + "Found the device: " + connectionHandler.getDeviceName() + "\n\t" + endpointId);
        }

        @Override
        public void onEndpointLost(@NonNull String endpointId) {
            MainActivity.makeLog("Lost endpoint: "+endpointId);
        }
    };

    public ConnectionLifecycleCallback connectionLifecycleCallback = new ConnectionLifecycleCallback() {
        @Override
        public void onConnectionInitiated(@NonNull String endpointId, @NonNull ConnectionInfo connectionInfo) {
            //Map endpointId to userId
            Log.e(TAG, SUB_TAG+"Accepted: " + endpointId + "\n\t" + connectionHandler.getDeviceName());

            endPointNames.put(endpointId, connectionInfo.getEndpointName());
//            connectedUsers.put(endpointId, connectionInfo.getEndpointName());
            MainActivity.makeLog("Accepting connection with "+endpointId+"/"+connectionInfo.getEndpointName());
            connectionHandler.getClient().acceptConnection(endpointId, payloadCallback);
        }

        @Override
        public void onConnectionResult(@NonNull String endpointId, @NonNull ConnectionResolution result) {
            if(result.getStatus().isSuccess()){
                MainActivity.makeLog("Successful connection to "+endpointId);
                //connectionHandler.setConnectionEndpointName(endpointId);
                connectedUsers.put(endpointId, endPointNames.get(endpointId));
                //Add new neighbor to list/map of neighbors
                connectionHandler.neighbors.put(connectedUsers.get(endpointId), endpointId);
                //Construct adjacency list message with current user object and set of mesh member userIds
                AdjacencyListMessage message = new AdjacencyListMessage(MainActivity.currentUser,
                        createIdList(connectionHandler.meshMembers));
                connectionHandler.getClient().sendPayload(endpointId, Payload.fromStream(constructStreamFromSerializable(message)));
            }else{
                MainActivity.makeLog("Connection failed with "+endpointId);
            }
        }

        @Override
        public void onDisconnected(@NonNull String endpointId) {
            MainActivity.makeLog("Disconnected from "+endpointId);
            connectionHandler.neighbors.remove(connectedUsers.get(endpointId));
            connectionHandler.meshMembers.remove(connectedUsers.get(endpointId));
            connectedUsers.remove(endpointId);
        }


    };

    class ConnectedUser {
        public String endpointId;
        public User user;

        public ConnectedUser(String endpointId, User user){
            this.endpointId = endpointId;
            this.user = user;
        }
    }


    public HashSet<String> createIdSet(HashMap<String, HashSet<String>> adjacencies){
        HashSet<String> allUsers = new HashSet<>();
        for(String neighbor : adjacencies.keySet()){
            for(String uid : adjacencies.get(neighbor)){
                allUsers.add(uid);
            }
        }
        return allUsers;
    }

    public String[] createIdList(HashMap<String, HashSet<String>> adjacencies){
        LinkedList<String> userList = new LinkedList<>();
        HashSet<String> allUsers = createIdSet(adjacencies);
        Iterator<String> iter = allUsers.iterator();
        while(iter.hasNext()){
            userList.add(iter.next());
        }
        return userList.toArray(new String[0]);
    }

    public InputStream constructStreamFromSerializable(Serializable obj){
        try {
            ByteArrayOutputStream baos = new ByteArrayOutputStream();
            ObjectOutputStream stream = new ObjectOutputStream(baos);
            stream.writeObject(obj);
            stream.flush();
            stream.close();

            return new ByteArrayInputStream(baos.toByteArray());
        }catch (IOException e){
            e.printStackTrace();
        }

        return null;
    }
}
