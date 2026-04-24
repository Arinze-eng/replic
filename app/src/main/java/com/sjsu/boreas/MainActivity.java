package com.sjsu.boreas;

import androidx.appcompat.app.AppCompatActivity;
import androidx.core.app.ActivityCompat;
import androidx.core.content.ContextCompat;

import android.Manifest;
import android.content.Intent;
import android.content.pm.PackageManager;
import android.os.AsyncTask;
import android.os.Bundle;
import android.util.Log;
import android.view.View;
import android.widget.Button;
import android.widget.Toast;

import com.sjsu.boreas.Database.LocalDatabaseReference;
import com.sjsu.boreas.Database.LoggedInUser.LoggedInUser;
import com.sjsu.boreas.Misc.ContextHelper;
import com.sjsu.boreas.Notifications.CustomNotification;
import com.sjsu.boreas.OfflineConnectionHandlers.NearbyConnectionHandler;
import com.sjsu.boreas.pdel_messaging.ChatActivity;

public class MainActivity extends AppCompatActivity {
	
	private static String TAG = "Boreas";
	private static String SUB_TAG = "---MainActivity ";

    public static final int REGISTER_ACTIVTY_START_CODE = 0;
    private static final int GROUPCHAT_ACTIVTY_REQUEST_CODE = 1;
    private static final int FRIENDS_ACTIVTY_REQUEST_CODE = 2;
    private static final int EMERGENCY_ACTIVTY_REQUEST_CODE = 3;
    public static final int LOGIN_ACTIVITY_REQUEST_CODE = 4;
    public static final int REGISTER_ACTIVITY_DONE_CODE = 5;

    public static LoggedInUser currentUser;
    public static MainActivity context;
    public static NearbyConnectionHandler nearbyConnectionHandler;
    private ContextHelper contextHelper = null;
    private LocalDatabaseReference localDatabaseReference = null;
    private CustomNotification customNotification = null;
    public static boolean newAcct = false;

    private Button buttonRegister, buttonGroupchat, buttonFriends, buttonEmergency;


    @Override
    protected void onCreate(Bundle savedInstanceState) {
		Log.e(TAG, SUB_TAG+"On create");
        super.onCreate(savedInstanceState);
        setContentView(R.layout.activity_main);
        context = this;

        //The order of these initializations matter here
        contextHelper = ContextHelper.initialize(getApplicationContext());
        customNotification = CustomNotification.initialize(contextHelper.getApplicationContext());
        localDatabaseReference = LocalDatabaseReference.initialize(contextHelper.getApplicationContext());

        if(ContextCompat.checkSelfPermission(this, Manifest.permission.ACCESS_WIFI_STATE) != PackageManager.PERMISSION_GRANTED)
            Toast.makeText(this, "Permission not granted!", Toast.LENGTH_SHORT).show();
        ContextCompat.checkSelfPermission(this, Manifest.permission.CHANGE_WIFI_STATE);
        ContextCompat.checkSelfPermission(this, Manifest.permission.CHANGE_NETWORK_STATE);
        ContextCompat.checkSelfPermission(this, Manifest.permission.INTERNET);
        ContextCompat.checkSelfPermission(this, Manifest.permission.ACCESS_NETWORK_STATE);
        ContextCompat.checkSelfPermission(this, Manifest.permission.ACCESS_COARSE_LOCATION);

        requestPermissions();

        //Connect the buttons in code to the UI buttons
        buttonRegister = (Button)findViewById(R.id.mainmenu_button_register);
        buttonGroupchat = (Button)findViewById(R.id.mainmenu_button_groupchat);
        buttonFriends = (Button)findViewById(R.id.mainmenu_button_friends);
        buttonEmergency = (Button)findViewById(R.id.mainmenu_button_emergency);

        //Start with buttons set to false
        buttonRegister.setEnabled(false);
        buttonGroupchat.setEnabled(false);
        buttonFriends.setEnabled(false);
        buttonEmergency.setEnabled(false);

        //Check if device is already registered
        checkRegistration();
    }

    /**
     * Checking if user is logged in
     */
    public void checkRegistration(){
		Log.e(TAG, SUB_TAG+"Checking if user is logged in");
        AsyncTask.execute(new Runnable() {
            @Override
            public void run() {
                currentUser = localDatabaseReference.getRegisteredUser();
                Log.e(TAG, SUB_TAG+"-----------------"+currentUser);
                MainActivity.this.runOnUiThread(new Runnable() {
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
            if (nearbyConnectionHandler == null)
                nearbyConnectionHandler = new NearbyConnectionHandler(this);

            Intent intent = new Intent(this, LandingPage.class);
            intent.putExtra("currentUser", currentUser);
            startActivity(intent);
        }
        else{
            Log.e(TAG, SUB_TAG+"User is not logged in");
            openLogIn();
        }
    }

    private void openRegistration(View v){
		Log.e(TAG, SUB_TAG+"Opening registration activity");
        Intent intent = new Intent(this, RegisterActivity.class);
        startActivityForResult(intent, REGISTER_ACTIVTY_START_CODE);
    }

    private void openLogIn(){
        Log.e(TAG, SUB_TAG+"Opening login activity");
        Intent intent = new Intent(this, LoginActivity.class);
        startActivity(intent);
    }

    public void openGroupchat(View v){
		Log.e(TAG, SUB_TAG+"Opening group chat");
        Intent intent = new Intent(this, ChatActivity.class);
        startActivity(intent);
    }

    public void openFriends(View v){
		Log.e(TAG, SUB_TAG+"Opening freinds");
    }

    public void openEmergency(View v){
		Log.e(TAG, SUB_TAG+"Opening Emergency");
    }

    public void onActivityResult(int requestCode, int resultCode, Intent data){
		Log.e(TAG, SUB_TAG+"On activity result");
        super.onActivityResult(requestCode, resultCode, data);
        switch(resultCode){
            case REGISTER_ACTIVTY_START_CODE:
                openRegistration(null);
                break;
            case REGISTER_ACTIVITY_DONE_CODE:
                newAcct = true;
                checkRegistration();
                break;
            case LOGIN_ACTIVITY_REQUEST_CODE:
                openLogIn();
                break;
        }
    }

    public void requestPermissions(){
		Log.e(TAG, SUB_TAG+"Request Permission");
        if(ContextCompat.checkSelfPermission(this,
                Manifest.permission.ACCESS_FINE_LOCATION) != PackageManager.PERMISSION_GRANTED){
            System.out.println("Permission not granted!");
            Log.e(TAG, SUB_TAG+"Permission not granted");
            ActivityCompat.requestPermissions(this, new String[]{
                            Manifest.permission.ACCESS_WIFI_STATE,
                            Manifest.permission.CHANGE_WIFI_STATE,
                            Manifest.permission.CHANGE_NETWORK_STATE,
                            Manifest.permission.INTERNET,
                            Manifest.permission.ACCESS_NETWORK_STATE,
                            Manifest.permission.ACCESS_COARSE_LOCATION,
                            Manifest.permission.BLUETOOTH,
                            Manifest.permission.BLUETOOTH_ADMIN,
                            Manifest.permission.ACCESS_FINE_LOCATION,
                    },
                    15);
        }else{
            System.out.println("Permission already granted");
        }
    }

    public static void makeLog(String text){
        Log.i("BOREAS_LOG", text);
    }
}
