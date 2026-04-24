package com.sjsu.boreas.Database.NearByUsers;

import androidx.room.Entity;
import com.sjsu.boreas.Database.Contacts.User;

import java.io.Serializable;

@Entity
public class NearByUsers extends User implements Serializable {
    public NearByUsers(String uid, String name, double latitude, double longitude, String publicKey) {
        super(uid, name, latitude, longitude, publicKey);
    }
}
