package com.sjsu.boreas;

import android.os.Bundle;
import android.util.Log;

import androidx.appcompat.app.AppCompatActivity;

public class GroupChatActivity extends AppCompatActivity {

    private static String TAG = "----Group chat -----";

    @Override
    protected void onCreate(Bundle savedInstanceState) {
        Log.e(TAG, "In group chat activity");

        super.onCreate(savedInstanceState);
        setContentView(R.layout.activity_group_chat);
    }
}
