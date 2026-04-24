package com.sjsu.boreas.Database.Messages;

import androidx.room.Dao;
import androidx.room.Insert;
import androidx.room.Query;

import java.util.List;

@Dao
public interface ChatMessageDao {

    @Query("SELECT * FROM (SELECT * FROM chatMessage " +
            "WHERE sender_uid is :chatPartnerID OR recipient_uid is :chatPartnerID AND mssgType is :mssgType " +
            "ORDER BY time " +
            "DESC LIMIT 20) ORDER BY time ASC")
    List<ChatMessage> getLastTwentyMessagesForUser(String chatPartnerID, int mssgType);

    @Query("SELECT * FROM chatMessage " +
            "WHERE mssgId is :messageId")
    List<ChatMessage> getSpecificMessage(String messageId);

    @Query("SELECT * FROM chatmessage")
    List<ChatMessage> getAllMessages();

    @Query("DELETE FROM chatmessage")
    void clearAllMessages();

    @Insert
    void insertAll(ChatMessage... chatMessages);



}
