package com.sjsu.boreas.OfflineConnectionHandlers.offline_messages;

import com.sjsu.boreas.Database.Contacts.User;

import java.io.Serializable;
import java.util.Collection;

public class NeighborRequestMessage implements Serializable {

    public User neighbor; //this neighbor
    public User [] subNeighbors; //neighbor's neighbors

    public NeighborRequestMessage(User neighbor, User [] subNeighbors){
        this.neighbor = neighbor;
        this.subNeighbors = subNeighbors;
    }
}
