package com.sjsu.boreas.ConnectionMethods;

/**
 * Represents a method of connecting to one or many other device(s). Subclass to implement
 * connection functionality
 */
public abstract class ConnectionMethod {

    public abstract int getConnectedDeviceCount();
}
