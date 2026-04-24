package com.sjsu.boreas.Messages;

import com.sjsu.boreas.Database.Contacts.User;

import java.io.Serializable;

/**
 * Represents a message that can be sent through Google Nearby.
 */
public class NearbyMessage implements Serializable {
    public User sender;
    public long timestamp;

    public NearbyMessage(User myuser){
        sender = myuser;
        timestamp = System.currentTimeMillis();
    }
}