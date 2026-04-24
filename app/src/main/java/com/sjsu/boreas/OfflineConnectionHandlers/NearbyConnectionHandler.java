package com.sjsu.boreas.OfflineConnectionHandlers;

import android.app.Activity;
import android.content.Context;
import android.os.Build;
import android.os.Handler;
import android.util.Base64;
import android.util.Log;
import android.widget.Toast;

import androidx.annotation.RequiresApi;
import androidx.fragment.app.Fragment;

import com.google.android.gms.nearby.Nearby;
import com.google.android.gms.nearby.connection.AdvertisingOptions;
import com.google.android.gms.nearby.connection.ConnectionsClient;
import com.google.android.gms.nearby.connection.DiscoveryOptions;
import com.google.android.gms.nearby.connection.Payload;
import com.google.android.gms.nearby.connection.Strategy;
import com.sjsu.boreas.Database.LocalDatabaseReference;
import com.sjsu.boreas.Database.Messages.ChatMessage;
import com.sjsu.boreas.Database.NearByUsers.NearByUsers;
import com.sjsu.boreas.LandingPage;
import com.sjsu.boreas.MainActivity;
import com.sjsu.boreas.GroupChats.OfflineGroupFragment;
import com.sjsu.boreas.Database.Contacts.User;
import com.sjsu.boreas.Messages.TextMessage;
import com.sjsu.boreas.pdel_messaging.ChatActivity;

import java.io.UnsupportedEncodingException;
import java.security.InvalidKeyException;
import java.security.KeyFactory;
import java.security.NoSuchAlgorithmException;
import java.security.PublicKey;
import java.security.spec.InvalidKeySpecException;
import java.security.spec.X509EncodedKeySpec;
import java.util.ArrayList;
import java.util.HashMap;
import java.util.HashSet;
import java.util.LinkedList;
import java.util.List;
import java.util.Map;
import java.util.Set;
import java.util.Timer;
import java.util.TimerTask;
import java.util.UUID;
import java.util.stream.Collectors;

import javax.crypto.BadPaddingException;
import javax.crypto.Cipher;
import javax.crypto.IllegalBlockSizeException;
import javax.crypto.NoSuchPaddingException;

public class NearbyConnectionHandler {

    private static final int ADVERTISE_PERIOD = 10000; //10 seconds
    private static final int DISCOVER_PERIOD = 120000; //2 minutes
    private static final int MAX_GROUPCHAT_FORWARDS = 3; //max hops a group chat message will be propagated

    private final static String TAG = "BOREAS";
    private final static String SUB_TAG = "---NearbyConnectionHandler ";
    protected final static String REQUEST_GET_NEIGHBORS = "getNeighborsRequest";
    private LocalDatabaseReference localDatabaseReference = LocalDatabaseReference.get();

    private Activity context;
    public Fragment activeFrag;
    public ChatActivity chatActivity;
    String deviceName;
    private NearbyCallbackHandler handlerNearby;
    private ConnectionsClient client;
    private String endpointName;

    private Activity activeActivity;
    private LinkedList<TextMessage> groupchatQueue;
    private LinkedList<TextMessage> peermessageQueue;

    private Timer timer;
    private TimerTask taskAdvertise;
    private int connectionState; //Records state of the handler.
    // 0 = just started, initial discovery, 1 = only advertising mode, 2 = advertising and discovering
    private boolean isAdvertising, isDiscovering;

    protected HashMap<String, HashSet<String>> meshMembers; //Members of current connection mesh (userId neighbor -> mesh member userIds)
    protected HashMap<String, String> neighbors; //neighbor userId to endpointId
    protected List<User> subNeighbors; //List of neighbors for each of this device's neighbors; neighbor id to ids of their neighbors
    protected int neighborsResponseTracker = 0;
    protected long neighborsResponseTimer = 0;
//    protected boolean isSubNeighborsUpdate = false; //Whether there's a new update to the subNeighbors map for the front-end to read

    @RequiresApi(api = Build.VERSION_CODES.N)
    public NearbyConnectionHandler(Activity context){
        Log.e(TAG, SUB_TAG+"NearbyConnectionHandler");
        this.context = context;

        groupchatQueue = new LinkedList<>();
        peermessageQueue = new LinkedList<>();

        deviceName = MainActivity.currentUser.uid;
        handlerNearby = new NearbyCallbackHandler(this);
        client= Nearby.getConnectionsClient(context);

        timer = new Timer();
        meshMembers = new HashMap<>();
        neighbors = new HashMap();
        subNeighbors = new ArrayList<User>(){
            @Override
            public boolean add(User user) {
                if(!this.contains(user)) return super.add(user);
                else return false;
            }
        };

        //startAdvertising();
        //startDiscovering();
        advanceConnectionState();
    }

    public void advanceConnectionState(){
        Log.e(TAG, SUB_TAG+"advanceConnectionState");
        switch(connectionState){
            case 0:
                startDiscovering();
                taskAdvertise = new TimerTask() {
                    @Override
                    public void run() {
                        connectionState = 1;
                        advanceConnectionState();
                    }
                };

                timer.schedule(taskAdvertise, ADVERTISE_PERIOD);
                break;
            case 1:
//                client.stopDiscovery();
                isDiscovering = false;
                startAdvertising();
                taskAdvertise = new TimerTask() {
                    @Override
                    public void run() {
                        connectionState = 0;
                        advanceConnectionState();
                    }
                };
                timer.schedule(taskAdvertise, DISCOVER_PERIOD);
                break;
        }

    }

    public void onStart(){
        Log.e(TAG, SUB_TAG+"onStart");
        advanceConnectionState();
    }

    public void onStop(){
        Log.e(TAG, SUB_TAG+"onStop");
        client.stopAllEndpoints();
        isAdvertising = false;
        isDiscovering = false;
        connectionState = 0;
    }

    public void startAdvertising(){
        Log.e(TAG, SUB_TAG+"startAdvertising");
        if(isAdvertising)
            return;
        isAdvertising = true;
        client.startAdvertising(deviceName, context.getPackageName(), handlerNearby.connectionLifecycleCallback,
                new AdvertisingOptions.Builder().setStrategy(Strategy.P2P_CLUSTER).build());
        System.out.println("Advertising");
    }

    public void startDiscovering(){
        Log.e(TAG, SUB_TAG+"startDiscovering");
        if(isDiscovering)
            return;
        isDiscovering = true;
        client.startDiscovery(context.getPackageName(), handlerNearby.endpointDiscoveryCallback,
                new DiscoveryOptions.Builder().setStrategy(Strategy.P2P_CLUSTER).build());
        System.out.println("Discovering");
    }

    public void startBroadcast(){
        Log.e(TAG, SUB_TAG+"startBroadcast");
        String payloadStr = "Hello from "+deviceName+"!";
        client.sendPayload(endpointName, Payload.fromBytes(payloadStr.getBytes()));
        System.out.println("Sent payload!");
    }

    //Helper Functions
    public String getDeviceName(){
        Log.e(TAG, SUB_TAG+"getDeviceName");
        return deviceName;
    }

    public void setConnectionEndpointName(String name){
        Log.e(TAG, SUB_TAG+"setConnectionEndpointName");
        endpointName = name;
    }

    public ConnectionsClient getClient(){
        Log.e(TAG, SUB_TAG+"ConnectionsClient: " + client);
        return client;
    }

    public NearbyCallbackHandler getHandlerNearby(){
        Log.e(TAG, SUB_TAG+"--Nearby handler: " + handlerNearby);
        return handlerNearby;
    }

    public void setActiveActivity(Activity act){
        Log.e(TAG, SUB_TAG+"setActiveActivity");
        activeActivity = act;
    }

    public void removeActiveActivity(){
        Log.e(TAG, SUB_TAG+"removeActiveActivity");
        activeActivity = null;
    }

    public void setActiveFragment(Fragment act){
        Log.e(TAG, SUB_TAG+"Set active frag");
        activeFrag = act;
    }

    public void removeActiveFragment(){
        Log.e(TAG, SUB_TAG+"removeACtiveFrag");
        activeFrag = null;
    }

    public List<TextMessage> dequeueGroupChats(){
        Log.e(TAG, SUB_TAG+"dequeueGroupChats");
        ArrayList<TextMessage> messages = new ArrayList<>(groupchatQueue.size());
        while(!groupchatQueue.isEmpty())
            messages.add(groupchatQueue.remove());
        return messages;
    }

    public boolean send1to1Message(Context activity, ChatMessage message){
        String encryptedText = "";
        boolean isEncrypted = false;

//        encryptedText = getEncryptedMessage(message);

//        ChatMessage message = new ChatMessage(MainActivity.currentUser, recipient, UUID.randomUUID().toString(),
//                encryptedText, System.currentTimeMillis(), true, ChatMessage.ChatTypes.ONEONONEOFFLINECHAT.getValue());
//        message.isEncrypted = isEncrypted;

        if(!(encryptedText.equals(""))){
            Log.e(TAG, SUB_TAG+"Message was encrypted");
            message.isEncrypted = true;
        }

        int forwardCount = 0;
        NearByUsers recipient = new NearByUsers(message.recipient.uid, message.recipient.name, message.recipient.latitude, message.recipient.longitude, message.recipient.publicKey);
        List<NearByUsers> nearestUsers = localDatabaseReference.getClosestNearByUsers(recipient);
        message.addForwarder(MainActivity.currentUser.getUid());
        for(NearByUsers user : nearestUsers){
            Log.e(TAG, SUB_TAG+"Nearest user: \t" + user.name);
            //Complete message forwarding once messages have been sent to at most 3 users
            if(forwardCount >= 3)
                break;
            if(neighbors.containsKey(user.uid)){
                Log.e(TAG, SUB_TAG+"In the contains user id function");
                //Don't resend to person who sent this message here OR someone who has forwarded this message before
                //First of above is subset of second, so only need to check second clause
                if(!message.isForwarder(user.getUid())){
                    Log.e(TAG, SUB_TAG+"Message sending yo: " + neighbors.get(user.uid));
                    //Send message to user and increment
                    forwardCount++;
                    Payload forwardPayload = Payload.fromStream(handlerNearby.constructStreamFromSerializable(message));
                    getClient().sendPayload(neighbors.get(user.uid), forwardPayload);
                    return true;
                }
            }
        }

        if(forwardCount == 0){
//            Toast.makeText(activity, "Error: No offline connections to send to!", Toast.LENGTH_LONG);
            Log.e(TAG, SUB_TAG+"Error: No offline connections to send to!");
        }

        return false;
    }

    private String getEncryptedMessage(ChatMessage message){
        Log.e(TAG, SUB_TAG+"Encrypting mssg");

        User recipient = message.recipient;
        String encryptedText = "";
        try {
            Cipher cipher = Cipher.getInstance("RSA/ECB/PKCS1Padding");
            X509EncodedKeySpec keySpec = new X509EncodedKeySpec(Base64.decode(recipient.publicKey, Base64.DEFAULT));
            KeyFactory fac = KeyFactory.getInstance("RSA");

            cipher.init(Cipher.ENCRYPT_MODE, fac.generatePublic(keySpec));
            encryptedText = Base64.encodeToString(cipher.doFinal(message.mssgText.getBytes("UTF-8")), Base64.DEFAULT);
        }catch (NoSuchAlgorithmException e){
            Toast.makeText(context, "Error: Could not encrypt text- RSA alg not found", Toast.LENGTH_SHORT);
            e.printStackTrace();
        }catch (NoSuchPaddingException e){
            Toast.makeText(context, "Error: Could not encrypt text- Padding alg not found", Toast.LENGTH_SHORT);
            e.printStackTrace();
        }catch (InvalidKeySpecException | InvalidKeyException e){
            Toast.makeText(context, "Error: Could not parse recipient's key", Toast.LENGTH_SHORT);
            e.printStackTrace();
        }catch (UnsupportedEncodingException | BadPaddingException | IllegalBlockSizeException e){
            Toast.makeText(context, "Error: Could not perform encryption", Toast.LENGTH_SHORT);
            e.printStackTrace();
        }

        return encryptedText;
    }

    public void sendGroupMessage(String text){
        Log.e(TAG, SUB_TAG+"sendGroupMessage");
        TextMessage message = new TextMessage(MainActivity.currentUser, true, text);
        if(activeActivity instanceof LandingPage && activeFrag instanceof OfflineGroupFragment){
            Log.e(TAG, SUB_TAG+"Active activity is Landing Page");
            ((OfflineGroupFragment) activeFrag).addMessage(true, null, text);
        }

        for(String neighbor : neighbors.keySet()){
            client.sendPayload(neighbors.get(neighbor), Payload.fromStream(handlerNearby.constructStreamFromSerializable(message)));
        }

    }

    public void receiveMessage(TextMessage message){
        Log.e(TAG, SUB_TAG+"receiveMessage");
        //Add to proper queue if need be
        if(message.isGroupchat && activeActivity instanceof ChatActivity){
            ((ChatActivity) activeActivity).addMessage(false, message.sender.name, message.message);
        }else{
            groupchatQueue.add(message);
        }

        User forwarder = message.forwarder;
        message.forwarder = MainActivity.currentUser;
        message.hops++;
        //If group chat, propagate it more
        if(message.isGroupchat && message.hops < MAX_GROUPCHAT_FORWARDS){
            System.out.println("Forwarding message from "+forwarder.name+": "+forwarder.uid);
            for(String neighbor : neighbors.keySet()){
                System.out.println("\t"+neighbor+" | "+neighbors.get(neighbor));
                if(neighbor.equals(forwarder.uid) || neighbors.get(neighbor).equals(forwarder.uid))
                    continue;
                MainActivity.makeLog("Sending payload to "+neighbor);
                client.sendPayload(neighbors.get(neighbor), Payload.fromStream(handlerNearby.constructStreamFromSerializable(message)));
            }
        }
    }

    public void sendMessage(String text) {
        Log.e(TAG, SUB_TAG+"sendMessage");
        receiveMessage(null, text);
        client.sendPayload(endpointName, Payload.fromBytes(text.getBytes()));
    }

    public void receiveMessage(String sender, String text) {
        Log.e(TAG, SUB_TAG+"receiveMessage");
        chatActivity.addMessage(sender == null, sender, text);
    }

    /**
     * Sends messages to get neighbor's neighbor lists
     Log.e(TAG, SUB_TAG+" requesting neighbors...");
     */

    public boolean triggerNeighborRequest(){
        subNeighbors.clear();
        if(neighbors.isEmpty()){
//            startAdvertising();
            startDiscovering();
            return false;
        }
        else{
            for(String neighbor : neighbors.keySet()){
                Log.e(TAG, SUB_TAG+"\tH-----yo neigbor yo request yo " + neighbor);
                Payload forwardPayload = Payload.fromStream(handlerNearby.constructStreamFromSerializable(REQUEST_GET_NEIGHBORS));
                getClient().sendPayload(neighbors.get(neighbor), forwardPayload);
//                getClient().sendPayload(neighbors.get(neighbor), Payload.fromBytes(REQUEST_GET_NEIGHBORS.getBytes()));
            }
        }
        return true;
    }
}
