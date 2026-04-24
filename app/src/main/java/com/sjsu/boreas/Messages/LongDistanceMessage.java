package com.sjsu.boreas.Messages;

import com.sjsu.boreas.Database.Contacts.User;

public class LongDistanceMessage extends NearbyMessage {

    public User forwarder, recipient;
    public String message;

    public LongDistanceMessage(User sender, User recipient, String message){
        super(sender);
        this.forwarder = recipient; //Construction only performed by original sender
        this.recipient = recipient;
        this.message = message;
    }
}
