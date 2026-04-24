package com.sjsu.boreas.Messages;

import com.sjsu.boreas.Database.Contacts.User;

public class TextMessage extends NearbyMessage{
    public boolean isGroupchat;
    public String message;
    public int hops;
    public User forwarder;

    public TextMessage(User user, boolean isGroupchat, String message){
        super(user);
        this.isGroupchat = isGroupchat;
        this.message = message;
        this.hops = 0;
        forwarder = user;
    }
}
