package com.sjsu.boreas.Misc;

import android.content.Intent;
import android.os.AsyncTask;
import android.util.Log;
import android.view.View;

import com.sjsu.boreas.Database.LocalDatabaseReference;
import com.sjsu.boreas.Database.LoggedInUser.LoggedInUser;
import com.sjsu.boreas.LandingPage;
import com.sjsu.boreas.LoginActivity;
import com.sjsu.boreas.MainActivity;
import com.sjsu.boreas.OfflineConnectionHandlers.NearbyConnectionHandler;
import com.sjsu.boreas.RegisterActivity;

public class SessionManager {

    private static String TAG = "BOREAS";
    private static String SUB_TAG = "--------------SessionManager--";

    private static SessionManager sessionManager = null;
    private LoggedInUser currentUser;
    private LocalDatabaseReference localDatabaseReference;

    public static SessionManager getInstance(){
        Log.e(TAG, SUB_TAG+"get instance");
        if(sessionManager == null){
            Log.e(TAG, SUB_TAG+"session manager is null");
            sessionManager = new SessionManager();
            return sessionManager;
        }
        return sessionManager;
    }

    private SessionManager(){
        Log.e(TAG, SUB_TAG+"Constructor");
    }

    public void checkForARegisteredUser(){
        Log.e(TAG, SUB_TAG+"Checking for a logged in user");
        AsyncTask.execute(new Runnable() {
            @Override
            public void run() {
                currentUser = localDatabaseReference.getRegisteredUser();
                MainActivity.context.runOnUiThread(new Runnable() {
                    @Override
                    public void run() {
                        if(currentUser == null)
                            openRegistration(null);
                        else
                            enableBasedOnLogIn();
                    }
                });

            }
        });
    }

    //This function checks registration and login
    public void enableBasedOnLogIn(){
        Log.e(TAG, SUB_TAG+"Enable based on registration");
        if(currentUser.isLoggedIn()) {
            Log.e(TAG, SUB_TAG+"User is logged in");
            if (MainActivity.nearbyConnectionHandler == null)
                MainActivity.nearbyConnectionHandler = new NearbyConnectionHandler(MainActivity.context);
            Intent intent = new Intent(MainActivity.context, LandingPage.class);
            intent.putExtra("currentUser", currentUser);
            MainActivity.context.startActivity(intent);
        }
        else{
            Log.e(TAG, SUB_TAG+"User is not logged in");
            openLogIn();
        }
    }

    private void openLogIn(){
        Log.e(TAG, SUB_TAG+"Opening login activity");
        Intent intent = new Intent(MainActivity.context, LoginActivity.class);
        MainActivity.context.startActivity(intent);
    }

    private void openRegistration(View v){
        Log.e(TAG, SUB_TAG+"Opening registration activity");
        Intent intent = new Intent(MainActivity.context, RegisterActivity.class);
        MainActivity.context.startActivityForResult(intent, MainActivity.REGISTER_ACTIVTY_START_CODE);
    }
}
