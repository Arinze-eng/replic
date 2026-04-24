package com.sjsu.boreas.ConnectionMethods;

/**
 * Represents another android device that this user has connected to and can send messages to.
 */
public abstract class ConnectedDevice {

    public abstract void sendMessage(String text);
}
