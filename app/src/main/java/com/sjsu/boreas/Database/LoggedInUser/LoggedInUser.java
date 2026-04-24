package com.sjsu.boreas.Database.LoggedInUser;

import android.util.Log;

import androidx.room.ColumnInfo;
import androidx.room.Entity;

import com.sjsu.boreas.Database.Contacts.User;

import java.io.Serializable;
import java.util.HashMap;
import java.util.Map;

@Entity
public class LoggedInUser extends User implements Serializable {

    private static String TAG = "BOREAS";
    private static String SUB_TAG = "----------Logged In User -- ";

    public LoggedInUser(String uid, String name, double latitude, double longitude, String password, String publicKey, String privateKey) {
        super(uid, name, latitude, longitude, publicKey);
        this.password = password;
        this.privateKey = privateKey;
        isLoggedIn = true;
    }

    @ColumnInfo(name="password")
    public String password;

    @ColumnInfo(name="isLoggedIn")
    public boolean isLoggedIn;

    @ColumnInfo(name = "privateKey")
    public String privateKey; //private key used to decrypt 1-1 messages sent to this user

    public boolean isLoggedIn(){
        return isLoggedIn;
    }

    public void logUserIn(){
        Log.e(TAG, SUB_TAG+"setting user as logged in");
        isLoggedIn = true;
    }

    public void logUserOut(){
        Log.e(TAG, SUB_TAG+"Setting user as logged out");
        isLoggedIn = false;
    }

    public String getPassword(){
        return password;
    }

    public Map<String, Object> toMap(){
        Log.e(TAG, SUB_TAG+"Top map");
        Map<String, Object> result = super.toMap();
        result.put("password", password);
        result.put("privateKey", privateKey);
        return result;
    }

//    public String toString(){
//        return name+": "+uid+"\n"+latitude + " , " + longitude+ ", " + isLoggedIn  +"\n";
//    }
}
