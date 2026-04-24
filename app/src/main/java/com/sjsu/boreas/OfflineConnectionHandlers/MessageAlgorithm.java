package com.sjsu.boreas.OfflineConnectionHandlers;

/**
 * Represents a type of messaging algorithm. It can send messages and receive them from others.
 */
public abstract class MessageAlgorithm {

    //Class itself specifies other details, eg. recipient
    public abstract void sendMessage(String text);

    public abstract void receiveMessage(String sender, String text); //TODO replace with specialized "message" object

    public void onStart(){}
    public void onStop(){}
}
