package com.sjsu.boreas.Database.PotentialContacts;

import android.util.Log;

import androidx.room.Entity;

import com.sjsu.boreas.Database.Contacts.User;

import java.io.Serializable;
import java.util.HashMap;

@Entity
public class PotentialContacts extends User implements Serializable {

    private static final String TAG = "BOREAS";
    private static final String SUB_TAG = "-----Potential_contacts-- ";

    public PotentialContacts(String uid, String name, double latitude, double longitude, String publicKey) {
        super(uid, name, latitude, longitude, publicKey);
    }

    public static PotentialContacts convertHashMapToUser(HashMap<String, Object> user_map){
        Log.e(TAG, SUB_TAG+"converting a hash map to user object.");

        PotentialContacts potentialContact = null;

        String contact_name, contact_id, contact_key;
        double contact_lat, contact_lon;

        contact_lat = (double) user_map.get("latitude");
        contact_lon = (double) user_map.get("longitude");
        contact_name = (String) user_map.get("name");
        contact_id = (String) user_map.get("uid");
        contact_key = (String) user_map.get("publicKey");

        potentialContact = new PotentialContacts(contact_id, contact_name, contact_lat, contact_lon, contact_key);

        return potentialContact;

    }
}
