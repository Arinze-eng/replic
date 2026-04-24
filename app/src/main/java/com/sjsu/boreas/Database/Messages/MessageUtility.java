package com.sjsu.boreas.Database.Messages;

import android.util.Log;

import com.sjsu.boreas.Database.Contacts.User;

import org.json.JSONException;
import org.json.JSONObject;

import java.util.HashMap;

public class MessageUtility {

    private static String TAG = "BOREAS";
    private static String SUB_TAG = "------MessageUtility ";

    public static ChatMessage convertJsonToMessage(String jsonStringMssg){
        ChatMessage mssg = null;
        JSONObject jsonMssg = null;

        String mssgId, mssgText, imgData;
        double latitude, longitude;
        long time;
        int mssgType;

        //First get json object from string
        try {
            jsonMssg = new JSONObject(jsonStringMssg);

            mssgId = jsonMssg.getString("mssgId");
            mssgText = jsonMssg.getString("mssgText");
            User sender = new User(jsonMssg.getJSONObject("sender"));
            User recipient = new User(jsonMssg.getJSONObject("recipient"));
//            imgData = jsonMssg.getString("imgData");
            //receiverId = jsonMssg.getString("receiverId");
            //receiverName = jsonMssg.getString("receiverName");
            //senderId = jsonMssg.getString("senderId");
            //senderName = jsonMssg.getString("senderName");
            //Log.e(TAG, SUB_TAG+"SO far so good: senderId: " + senderId);
            //latitude = Double.parseDouble(jsonMssg.getString("latitude"));
            //longitude = Double.parseDouble(jsonMssg.getString("longitude"));
            //Log.e(TAG, SUB_TAG+"SO far so good 2");
            time = Long.parseLong(jsonMssg.getString("time"));
            mssgType = Integer.parseInt(jsonMssg.getString("mssgType"));

            mssg = new ChatMessage(sender, recipient, mssgId, mssgText, time, false, mssgType);
            mssg.contains_img = Boolean.parseBoolean(jsonMssg.getString("contains_img"));
            mssg.isEncrypted = Boolean.parseBoolean(jsonMssg.getString("isEncrypted"));
//            mssg.imgData = imgData;

//            ContextHelper contextHelper = ContextHelper.get(null);
//            DatabaseReference databaseReference = DatabaseReference.get(contextHelper.getApplicationContext());
//            databaseReference.saveChatMessageLocally(mssg); //Save chat message
//
//            //Save the sender's info to the database
//            User sender = new User(senderId, senderName, latitude, longitude, false);
//            if(databaseReference.isUserAlreadyInContacts(sender)){
//                Log.e(TAG, SUB_TAG+"The user is already in contacts");
//            }else {
//                //TODO: this user shouldn't be added to contacts,
//                // the person should be added to a different table of potential contacts
//                // before he/she is verified as a contact by the app owner
//                databaseReference.addContact(sender);
//            }

            Log.e(TAG, SUB_TAG+"New mssg: "+ mssg.recipient.getName() + ", mssgType: " + mssg.mssgType);
        } catch (JSONException e) {
            Log.e(TAG, SUB_TAG+"JSON exception: \n\t" + e);
            e.printStackTrace();
        }

        return mssg;
    }

    public static ChatMessage convertHashMapToChatMessage(HashMap<String, Object> mssg){
        Log.e(TAG, SUB_TAG+"converting a hash map to ChatMessage object.");

        ChatMessage mssgObj = new ChatMessage();

        mssgObj.fromMap(mssg);

        return mssgObj;

    }

}
