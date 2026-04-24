package com.sjsu.boreas;

import androidx.appcompat.app.AppCompatActivity;

import android.content.ClipData;
import android.content.ClipboardManager;
import android.content.Context;
import android.content.Intent;
import android.graphics.Color;
import android.net.Uri;
import android.os.AsyncTask;
import android.os.Build;
import android.os.Bundle;
import android.util.Log;
import android.view.View;
import android.view.Window;
import android.view.WindowManager;
import android.widget.Button;
import android.widget.EditText;
import android.widget.ImageButton;
import android.widget.TextView;
import android.widget.Toast;

import androidx.core.content.ContextCompat;

import com.sjsu.boreas.Database.LocalDatabaseReference;
import com.sjsu.boreas.Database.LoggedInUser.LoggedInUser;
import com.sjsu.boreas.Database.Messages.ChatMessage;
import com.sjsu.boreas.Events.Event;
import com.sjsu.boreas.Events.EventListener;
import com.sjsu.boreas.Misc.ContextHelper;
import com.sjsu.boreas.PhoneBluetoothRadio.BlueTerm;

import java.util.HashMap;
import java.util.Locale;

public class SettingsActivity extends AppCompatActivity implements EventListener {
    private static String TAG = "BOREAS";
    private static String SUB_TAG = "-------Settings activity-- ";

    private TextView userNameLabel;
    private TextView location;
    private Button logoutButton;
    private ImageButton connectDevice;
//    private Button connectPi;
    private Button getMessagesFromRadio;
    private LocalDatabaseReference localDatabaseReference;
    private TextView userToken;
    private EditText givenDeviceName;
    private Context mActivity;
    private LoggedInUser mCurrentUser;
    private ImageButton clipboard;
    private ImageButton publicKey;
    private ImageButton privatekey;
    private TextView publicKeytext;
    private TextView privatekeytext;

    public static boolean radio_is_connected = true;

    private Event event_radio_connected = Event.get(Event.radioConnected);
    private Event event_radio_disconnected = Event.get(Event.radioDisconnected);

    @Override
    protected void onCreate(Bundle savedInstanceState) {
        super.onCreate(savedInstanceState);
        setContentView(R.layout.activity_settings);
        mCurrentUser = MainActivity.currentUser;

        Log.e(TAG, SUB_TAG + "on create");
        mActivity = this;

        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.LOLLIPOP){
            Window window = getWindow();
            window.clearFlags(WindowManager.LayoutParams.FLAG_TRANSLUCENT_STATUS);
            window.addFlags(WindowManager.LayoutParams.FLAG_DRAWS_SYSTEM_BAR_BACKGROUNDS);
            getWindow().getDecorView().setSystemUiVisibility(View.SYSTEM_UI_FLAG_LIGHT_STATUS_BAR);
            window.setStatusBarColor(ContextCompat.getColor(ContextHelper.get().getApplicationContext(),R.color.backgroundAlt));
        }

        localDatabaseReference = LocalDatabaseReference.get();
        initView();
    }

    @Override
    protected void onRestart() {
        super.onRestart();
        localDatabaseReference = LocalDatabaseReference.get();
        initView();
    }

    private void initView(){
        Log.e(TAG, SUB_TAG+"Initializing view: " + mCurrentUser.getUid());
        userNameLabel = findViewById(R.id.settings_user_name);
        location = findViewById(R.id.location);
        logoutButton = findViewById(R.id.logout_button);
        userToken = findViewById(R.id.user_token);
        clipboard = findViewById(R.id.copy_userid);
        publicKey = findViewById(R.id.copy_public_key);
        privatekey = findViewById(R.id.copy_private_key);
        publicKeytext = findViewById(R.id.public_key);
        privatekeytext = findViewById(R.id.private_key);
//        connectPi = findViewById(R.id.connect_pi);
        connectDevice = findViewById(R.id.connect_given_device);
        givenDeviceName = findViewById(R.id.given_device_name);
        getMessagesFromRadio = findViewById(R.id.get_mssgs_from_radio);

        publicKeytext.setText(mCurrentUser.publicKey);
        privatekeytext.setText(mCurrentUser.privateKey);
        userNameLabel.setText(mCurrentUser.name);
        userToken.setText(mCurrentUser.getUid());

        clipboard.setOnClickListener(new View.OnClickListener() {
            @Override
            public void onClick(View v) {
                ClipboardManager clipboard = (ClipboardManager) getSystemService(Context.CLIPBOARD_SERVICE);
                ClipData clip = ClipData.newPlainText("boreas user token", mCurrentUser.getUid());
                clipboard.setPrimaryClip(clip);
            }
        });

        publicKey.setOnClickListener(new View.OnClickListener() {
            @Override
            public void onClick(View v) {
                ClipboardManager clipboard = (ClipboardManager) getSystemService(Context.CLIPBOARD_SERVICE);
                ClipData clip = ClipData.newPlainText("boreas user token", mCurrentUser.publicKey);
                clipboard.setPrimaryClip(clip);
            }
        });

        privatekey.setOnClickListener(new View.OnClickListener() {
            @Override
            public void onClick(View v) {
                ClipboardManager clipboard = (ClipboardManager) getSystemService(Context.CLIPBOARD_SERVICE);
                ClipData clip = ClipData.newPlainText("boreas user token", mCurrentUser.privateKey);
                clipboard.setPrimaryClip(clip);
            }
        });



        logoutButton.setOnClickListener(new View.OnClickListener() {
            @Override
            public void onClick(View v) {
                Log.e(TAG, SUB_TAG + "onclick logout");
                logout();
            }
        });

////        connectPi.setOnClickListener(new View.OnClickListener() {
////            @Override
////            public void onClick(View v) {
//                Log.e(TAG, SUB_TAG + "Setting device name to pi");
//                setDeviceNameToRaspberryPi();
//            }
//        });

        connectDevice.setOnClickListener(new View.OnClickListener() {
            @Override
            public void onClick(View v) {
                Log.e(TAG, SUB_TAG + "setting device name to laptop");
                setDeviceNameToGiveDeviceName();
            }
        });

        getMessagesFromRadio.setOnClickListener(new View.OnClickListener() {
            @Override
            public void onClick(View v) {
                Log.e(TAG, SUB_TAG + "On cick of getting mssgs from radio");
                pokeRadioForMessages();
            }
        });

        userNameLabel.setOnClickListener(new View.OnClickListener() {
            @Override
            public void onClick(View v) {
                Intent intent = new Intent(SettingsActivity.this, EditProfileActivity.class);
               //intent.putExtra("mCurrentUser", mCurrentUser);
                startActivity(intent);
            }
        });

        location.setOnClickListener(new View.OnClickListener() {
            @Override
            public void onClick(View v) {
                String uri = String.format(Locale.ENGLISH, "http://maps.google.com/maps?q=loc:%f,%f",
                        mCurrentUser.latitude,mCurrentUser.longitude);
                Intent intent = new Intent(Intent.ACTION_VIEW, Uri.parse(uri));
                startActivity(intent);
            }
        });
    }

    private void logout() {
        Log.e(TAG, SUB_TAG + "loging out");

        AsyncTask.execute(new Runnable() {
            @Override
            public void run() {
                localDatabaseReference.logUserOut(mCurrentUser);
                runOnUiThread(new Runnable() {
                    @Override
                    public void run() {
                        MainActivity.context.checkRegistration();
                    }
                });
            }
        });
    }

    private void checkForRadioConnection(){
        Log.e(TAG, SUB_TAG+"Checking for that connect tho");
        boolean isRadioConnected = BlueTerm.getSerialConnectionStatus();

        if(isRadioConnected){
            Log.e(TAG, SUB_TAG + "Radio is connected");
            event_radio_connected.trigger(null);
        }
        else{
            Log.e(TAG, SUB_TAG+"Radio isn't connected yo");
            event_radio_disconnected.trigger(null);
        }
    }

    private void setDeviceNameToRaspberryPi(){
        Log.e(TAG, SUB_TAG+"Setting device to connect to raspberry pi");
    }

    private void setDeviceNameToGiveDeviceName(){
        Log.e(TAG, SUB_TAG+"Setting device to connect to laptop");
        String device_name = givenDeviceName.getText().toString();

        if(device_name != null && !(device_name.isEmpty())){
            Log.e(TAG, SUB_TAG+"Setting the device name to this: " + device_name);
            BlueTerm.setDefaultDeviceName(device_name);
        }
        else {
            Log.e(TAG,SUB_TAG + "Device name given is empty");
            Toast.makeText(mActivity, "Device name is empty", Toast.LENGTH_LONG).show();
        }
    }

    private void pokeRadioForMessages(){
        Log.e(TAG, SUB_TAG+"Poking radio for mssgs");

        //Make a special mssg
        ChatMessage chatMessage = new ChatMessage();
        chatMessage.mssgType = ChatMessage.ChatTypes.GETMESSAGESFROMRADIO.getValue();

        BlueTerm.sendMessage(chatMessage);
        Toast.makeText(mActivity, "Request for update sent", Toast.LENGTH_LONG).show();
    }

    private void setCheckRadioButtonColor(final int color){
        Log.e(TAG, SUB_TAG + "Setting the button color to: " + color);
//        runOnUiThread(new Runnable() {
//            @Override
//            public void run() {
//                checkRadioButton.setBackgroundColor(color);
//            }
//        });

    }

    @Override
    public void eventTriggered(HashMap<String, Object> packet, String type) {
        Log.e(TAG, SUB_TAG + "Event was triggered");

        if(type.equals(Event.radioConnected)){
            Log.e(TAG, SUB_TAG+"Radio device connected");
            radio_is_connected = true;
            setCheckRadioButtonColor(Color.GREEN);
        }
        else if(type.equals(Event.radioDisconnected)){
            Log.e(TAG, SUB_TAG+"Radio device disconnected");
            radio_is_connected = false;
            setCheckRadioButtonColor(Color.MAGENTA);
        }
    }
}