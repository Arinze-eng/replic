package com.sjsu.boreas.pdel_messaging;

public class Message {
    private String text;
    private String sender;
    private boolean isSender;

    public Message(String text, String sender, boolean isSender){
        this.text = text;
        this.sender = sender;
        this.isSender = isSender;
    }

    public String getText(){
        return text;
    }

    public String getSender(){
        return sender;
    }

    public boolean getIsSender(){
        return isSender;
    }
}
