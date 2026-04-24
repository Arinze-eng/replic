package com.sjsu.boreas.Notifications;

import android.app.NotificationChannel;
import android.app.NotificationManager;
import android.content.Context;
import android.os.Build;
import android.util.Log;

import androidx.core.app.NotificationCompat;

import com.sjsu.boreas.Database.Messages.ChatMessage;
import com.sjsu.boreas.MainActivity;

public class CustomNotification {

    private static String TAG = "BOREAS";
    private static String SUB_TAG = "------Notification-- ";
    private Context mContext;
    private static CustomNotification mCustomNotification = null;
    private NotificationManager mNotificationManager = null;

    private static String ANDROID_CHANNEL_ID = "com.sjsu.boreas.ANDROID";
    private static String ANDROID_CHANNEL_NAME = "ANDROID CHANNEL";

    public static CustomNotification initialize(Context context){
        Log.e(TAG, SUB_TAG+"Initialize");
        if(mCustomNotification == null){
            mCustomNotification = new CustomNotification(context);
            if(mCustomNotification == null)
                Log.e(TAG, SUB_TAG+"Getting notification instance (which is null), in intialize funtion");
            return mCustomNotification;
        }
        else {
            return mCustomNotification;
        }
    }

    public static CustomNotification get(){
        Log.e(TAG, SUB_TAG+"Getting notification instance");
        if(mCustomNotification == null)
            Log.e(TAG, SUB_TAG+"Getting notification instance (which is null)");
        return mCustomNotification;
    }

    private CustomNotification(Context context){
        Log.e(TAG, SUB_TAG+"Constructor");
        mContext = context;
        createNotificationChannel();
    }

    private void createNotificationChannel() {
        // Create the NotificationChannel, but only on API 26+ because
        // the NotificationChannel class is new and not in the support library
        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.O) {
            int importance = NotificationManager.IMPORTANCE_DEFAULT;
            NotificationChannel channel = new NotificationChannel(ANDROID_CHANNEL_ID, ANDROID_CHANNEL_NAME, importance);
            // Register the channel with the system; you can't change the importance
            // or other notification behaviors after this
           getNotificationManager().createNotificationChannel(channel);
        }
    }

    private NotificationManager getNotificationManager() {
        Log.e(TAG, SUB_TAG+"Get notification manager");
        if (mNotificationManager == null) {
            mNotificationManager = (NotificationManager) mContext.getSystemService(Context.NOTIFICATION_SERVICE);
        }
        return mNotificationManager;
    }

    private NotificationCompat.Builder getAndroidChannelNotification(String title, String body) {
        Log.e(TAG, SUB_TAG+"Getting android channel notification");
        return new NotificationCompat.Builder(mContext, ANDROID_CHANNEL_ID)
                .setContentTitle(title)
                .setContentText(body)
                .setSmallIcon(android.R.drawable.stat_notify_more)
                .setAutoCancel(true);
    }

    public void sendMssgRecvdNotification(ChatMessage message){
        Log.e(TAG, SUB_TAG+"send notification of a mssg being received");
        if(!(message.sender.getUid().equals(MainActivity.currentUser.getUid()))) {
            Log.e(TAG, SUB_TAG+"The message is a received mssg");
            NotificationCompat.Builder mBuilder = getAndroidChannelNotification("Text Recieved", message.mssgText);
            getNotificationManager().notify(101, mBuilder.build());
        }
    }
}
