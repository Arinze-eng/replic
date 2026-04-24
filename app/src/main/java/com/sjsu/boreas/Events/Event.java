package com.sjsu.boreas.Events;

import android.util.Log;

import java.util.ArrayList;
import java.util.HashMap;
import java.util.List;

public class Event {
    private static List<Event> events = new ArrayList<>();
    private static String TAG = "BOREAS";
    private static String SUB_TAG = "-----Event class-- ";

    // replace with enums
    public static final String CHAT_MSSG = "chat_messages";
    public static final String USER_ADDED = "user_added";
    public static final String USER_REMOVED = "user_removed";
    public static final String NBR_UPDATED = "neighbor_response";

    public static final String radioConnected = "radioconnected";
    public static final String radioDisconnected = "radiodisconnected";

    private String event_id;
    private List<EventListener> listeners = new ArrayList<>();

    public static Event get(String e_id){
        Log.e(TAG, SUB_TAG+"getting the instance");
        e_id = e_id.toLowerCase();
        for(Event e : events){
            if(e.getID().equals(e_id)) return e;
        }
        return new Event(e_id);
    }

    private Event(String id){
        Log.e(TAG, SUB_TAG+"Constructor");
        this.event_id = id;
        events.add(this);
    }

    public void addListener(EventListener l){
        Log.e(TAG, SUB_TAG+"adding listener: "+l.toString() + "\n\t\t\t" + l.getClass() + ", ");
        if(!this.listeners.contains(l.getClass())) this.listeners.add((l));
    }

    public void deleteListener (EventListener l){
        Log.e(TAG, SUB_TAG+"deleting listener: " + l);
        this.listeners.remove(l);
    }

    public String getID(){
        Log.e(TAG, SUB_TAG+"getting ID");
        return this.event_id;
    }

    public String getStarted(){
        return this.event_id+"_started";
    }

    public String getEnded(){
        return this.event_id+"_ended";
    }

    public void trigger(HashMap<String, Object> packet){
        Log.e(TAG, SUB_TAG+"Trigger++*************************************");
        trigger(packet, this.event_id);
    }

    private void trigger(HashMap<String, Object> packet, String id){
        int i = 0;
        for(EventListener l : listeners){
            Log.e(TAG, SUB_TAG+"In the loop, listener: " + l  + ", EVENT: " + event_id + ", " + i++);
            try {
                l.eventTriggered(packet, id);
            }
            catch(Exception e){
                Log.e(TAG, SUB_TAG+"\terror: " + e);
            }
        }
    }

    public void started(HashMap<String, Object> packet){
        trigger(packet, this.event_id + "_started");
    }

    public void ended(HashMap<String, Object> packet){
        trigger(packet, this.event_id + "_ended");
    }
}
