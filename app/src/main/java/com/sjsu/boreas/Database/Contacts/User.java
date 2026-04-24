package com.sjsu.boreas.Database.Contacts;

import android.util.Log;

import androidx.annotation.NonNull;
import androidx.room.ColumnInfo;
import androidx.room.Entity;
import androidx.room.PrimaryKey;

import com.sjsu.boreas.Database.Messages.ChatMessage;

import org.json.JSONException;
import org.json.JSONObject;

import java.io.Serializable;
import java.util.HashMap;
import java.util.Map;

@Entity
public class User implements Serializable {

    private static final String TAG = "BOREAS";
    private static final String SUB_TAG = "-------User cleass----- ";

    public User(String uid, String name, double latitude, double longitude, String publicKey){
        this.uid = uid;
        this.name = name;
        this.latitude = latitude;
        this.longitude = longitude;
        this.publicKey = publicKey;
    }

    public User(JSONObject user) throws JSONException {
        name = user.getString("name");
        uid = user.getString("uid");
        publicKey = user.getString("publicKey");
        latitude = user.getDouble("latitude");
        longitude = user.getDouble("longitude");
    }

    @NonNull
    @PrimaryKey
    public String uid;

    @ColumnInfo(name = "newMessage")
    public boolean newMessage = false;

    @ColumnInfo(name = "time")
    public long lastMessageTime = -1;

    @ColumnInfo(name = "lastMessage")
    public String lastMessage;

    @ColumnInfo(name = "name")
    public String name;

    @ColumnInfo(name = "latitude")
    public double latitude;

    @ColumnInfo(name = "longitude")
    public double longitude;

    @ColumnInfo(name = "publicKey")
    public String publicKey;

    @Override
    public boolean equals(Object u){
        if(u instanceof User){
            return this.uid.equals(((User)u).uid);
        }
        else return false;
    }

    @Override
    public int hashCode(){
        return this.uid.hashCode();
    }

    /**
     *
     * @return JSON representation of this object
     */
    public String toString(){
        String str = "{";
        str += "\"name\": \""+name+"\",";
        str += "\"uid\": \""+uid+"\",";
        str += "\"latitude\": "+latitude+",";
        str += "\"longitude\": "+longitude+",";
        str += "\"publicKey\": \""+publicKey+"\"";
        str += "}";
        return str;
        //return name+": "+uid+"\n"+latitude + " , " + longitude+"\n"+publicKey+"\n";
    }

    public Map<String, Object> toMap(){
        HashMap<String, Object> result = new HashMap<>();
        result.put("uid", uid);
        result.put("name", name);
        result.put("latitude", latitude);
        result.put("longitude", longitude);
        result.put("publicKey", publicKey);
        return result;
    }

    public String getUid(){
        return uid;
    }
    public String getName(){return name;}
    public double getLatitude(){return latitude;}
    public double getLongitude(){return longitude;}

    public static User convertHashMapToUser(HashMap<String, Object> user_map){
        Log.e(TAG, SUB_TAG+"converting a hash map to user object.");

        User contact = null;

        String contact_name, contact_id, contact_key;
        double contact_lat, contact_lon;

        contact_lat = (double) user_map.get("latitude");
        contact_lon = (double) user_map.get("longitude");
        contact_name = (String) user_map.get("name");
        contact_id = (String) user_map.get("uid");
        contact_key = (String) user_map.get("publicKey");

        contact = new User(contact_id, contact_name, contact_lat, contact_lon, contact_key);

        return contact;

    }
}
