package com.sjsu.boreas.Database.Messages;

import android.net.Uri;
import android.util.Log;

import androidx.annotation.NonNull;
import androidx.room.ColumnInfo;
import androidx.room.Embedded;
import androidx.room.Entity;
import androidx.room.Ignore;
import androidx.room.PrimaryKey;

import com.sjsu.boreas.ChatView.MediaFilesRecyclerItems.FileItem;
import com.sjsu.boreas.Database.Contacts.User;
import com.sjsu.boreas.Events.messageListener;

import org.json.JSONStringer;

import java.io.Serializable;
import java.util.ArrayList;
import java.util.HashMap;
import java.util.LinkedList;
import java.util.List;
import java.util.Map;

@Entity
public class ChatMessage implements Serializable {

    private static String TAG = "BOREAS";
    private static String SUB_TAG = "-----ChatMessage data class ";
    private static messageListener listener;

    public enum ChatTypes {
        ONEONONEONLINECHAT(0),
        ONEONONEOFFLINECHAT(1),
        ONLINEGROUPCHAT(2),
        OFFLINEGROUPCHAT(3),
        GETMESSAGESFROMRADIO(4),
        ONEONONEOFFLINERADIO(5);

        private int value;
        private static Map map = new HashMap<>();

        private ChatTypes(int value) {
            this.value = value;
        }

        public int getValue() {
            return value;
        }

    }

    public ChatMessage(User sender, User recipient, String mssgId, String mssgText,
                       long time, boolean isMyMssg, int mssgType){
        this.mssgId = mssgId;
        this.time = time;
        this.mssgText = mssgText;
        this.isMyMssg = isMyMssg;
        this.mssgType = mssgType;

        this.sender = sender;
        this.recipient = recipient;
        this.contains_img = false;

        forwarderIds = new LinkedList<>();
    }

    @Ignore
    public ChatMessage(){
        this.mssgId = String.valueOf(System.currentTimeMillis());
        this.time = System.currentTimeMillis();
        this.mssgText = "testing";
        this.isMyMssg = false;
        this.mssgType = ChatTypes.ONEONONEONLINECHAT.getValue();
        this.sender = new User("1234-abcd", "test SENDER", 0, 0, "");
        this.recipient = new User("5678-efab", "test RECIPIENT", 0, 0, "");

        forwarderIds = new LinkedList<>();
    }

    @Ignore
    public ChatMessage(ChatMessage m){
        this.mssgId = m.mssgId;
        this.time = m.time;
        this.mssgText = m.mssgText;
        this.isMyMssg = m.isMyMssg;
        this.mssgType = m.mssgType;
        this.sender = m.sender;
        this.recipient = m.recipient;
        this.isEncrypted = m.isEncrypted;
        this.contains_img = m.contains_img;
        if(contains_img){
            this.imgData = m.imgData;
            this.imgUri = m.imgUri;
        }
        forwarderIds = m.forwarderIds;
    }

    public String getSenderName(){return sender.name;}

    @NonNull
    @PrimaryKey
    public String mssgId;

    @ColumnInfo(name = "mssgText")
    public String mssgText;

    @ColumnInfo(name = "time")
    public long time;

    @ColumnInfo(name = "isMyMssg")
    public boolean isMyMssg;

    @ColumnInfo(name = "mssgType")
    public int mssgType;

//    @ColumnInfo(name = "imgData")
    public String imgData;

    @ColumnInfo(name = "imgUri")
    public String imgUri;

    @ColumnInfo(name = "contains_img")
    public boolean contains_img;

    @Embedded(prefix = "sender_")
    public User sender;

    @Embedded(prefix = "recipient_")
    public User recipient;

    //Not stored in DB, only used by messages in transit

    @Ignore
    public boolean isEncrypted;

    @Ignore
    private List<String> forwarderIds;

    public String toString(){
       String mssgStr = "{" +
                "mssgId: \"" + mssgId + "\","
                +   "\"mssgText\": \"" + mssgText + "\","
                +   "\"sender\": "+ sender.toString() + ","
                +   "\"recipient\": "+ recipient.toString() + ","
                +   "\"time\": " + String.valueOf(time) + ","
                +   "\"isMyMssg\": " + String.valueOf(isMyMssg) + ","
                +   "\"mssgType\": " + String.valueOf(mssgType) + ","
                +   "\"imgData\": " + imgData + ","
                +   "\"imgUri\": " + imgUri + ","
                +   "\"contains_img\": " + contains_img + ","
               +   "\"isEncrypted\": " + isEncrypted
                + "} \n";
        return mssgStr;
    }

    public void fromMap(HashMap<String, Object> chatMessage){
        sender = User.convertHashMapToUser((HashMap<String, Object>) chatMessage.get("sender"));
        recipient = User.convertHashMapToUser((HashMap<String, Object>)chatMessage.get("recipient"));
        mssgId = (String) chatMessage.get("mssgId");
        mssgText = (String) chatMessage.get("mssgText");
        mssgType = (Integer) chatMessage.get("mssgType");
        isMyMssg = (Boolean) chatMessage.get("isMyMssg");
        time = (Long) chatMessage.get("time");
        imgUri = (String) chatMessage.get("imgUri");
        contains_img = (boolean) chatMessage.get("contains_img");
        isEncrypted = (boolean) chatMessage.get("isEncrypted");

        if(contains_img){
            imgData = (String) chatMessage.get("imgData");
        }
    }

    public Map<String, Object> toMap(){
        HashMap<String, Object> result = new HashMap<>();
        result.put("mssgId", mssgId);
        result.put("mssgText", mssgText);
        result.put("sender", sender.toMap());
        result.put("recipient", recipient.toMap());
        result.put("time", time);
        result.put("isMyMssg", isMyMssg);
        result.put("mssgType", mssgType);
        result.put("isEncrypted", isEncrypted);
        //We don't push the imgUri to online since thats only in the scope of local storage
        String tmp = "";
        if(imgData != null) {
            Log.e(TAG, SUB_TAG+"\n" + imgData);
            tmp = imgData;
        }
        result.put("imgData", tmp);
        result.put("imgUri", imgUri);
        result.put("contains_img", contains_img);
        return result;
    }

    //This function at the moment is only being used by the firebase storage call
    //  function in chatactivity2
    public Map<String, Object> imgDataMap(){
        Log.e(TAG, SUB_TAG+"only getting the mapped object in mssg");
        HashMap<String, Object> result = new HashMap<>();

        result.put("mssgId", mssgId);
        result.put("imgData", imgData);
        return result;
    }

    public static void addMessageListener(messageListener mssgListener){
        Log.e(TAG, SUB_TAG+"adding a listener");
        listener = mssgListener;
    }

//    public static void notifySpecificListener(String senderId, ChatMessage mssg){
//        Log.e(TAG, SUB_TAG+"notify specific user");
//        for(int i = 0; i < listeners.size(); i++){
//            if(listeners.get(i).getChatPartnerID().equals(senderId)){
//                listeners.get(i).newMessageReceived(mssg);
//            }
//        }
//    }

    public static void notifyListener(ChatMessage mssg){
        Log.e(TAG, SUB_TAG+"Notifying all listeners: This function is for testing");
        if(mssg.sender.getUid().equals(listener.getChatPartnerID())) {
            listener.newMessageReceived(mssg);
        }
        else{
            Log.e(TAG, SUB_TAG+mssg.sender.getUid()+"\n\t\t"+listener.getChatPartnerID());
        }
//        for(int i = 0; i < listeners.size(); i++){
//            listeners.get(i).newMessageReceived(mssg);
//        }
    }

    public void addForwarder(String uid){
        forwarderIds.add(uid);
    }

    public boolean isForwarder(String uid){
        return forwarderIds.contains(uid);
    }

}
