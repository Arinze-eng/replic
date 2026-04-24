package com.sjsu.boreas.Messages;

import com.sjsu.boreas.Database.Contacts.User;

/**
 * Send a list of currently adjacent users. If the adjacency list overlaps the recipient's
 * stored list, then close the connection. Otherwise, union the adjacency lists
 */
public class AdjacencyListMessage extends NearbyMessage {
    public String [] adjacentIds;

    public AdjacencyListMessage(User myuser, String [] adjacentIds){
        super(myuser);
        this.adjacentIds = adjacentIds;
    }
}
