package com.sjsu.boreas.GroupChats;

import android.os.Bundle;
import android.util.Log;
import android.view.LayoutInflater;
import android.view.View;
import android.view.ViewGroup;
import android.widget.Button;
import android.widget.EditText;
import android.widget.ListView;

import androidx.appcompat.app.AppCompatActivity;
import androidx.appcompat.widget.Toolbar;
import androidx.fragment.app.Fragment;

import com.sjsu.boreas.MainActivity;
import com.sjsu.boreas.R;
import com.sjsu.boreas.Messages.TextMessage;
import com.sjsu.boreas.pdel_messaging.ChatMessageAdapter;
import com.sjsu.boreas.pdel_messaging.Message;

import java.util.List;

public class OfflineGroupFragment extends Fragment {

    private static String TAG = "BOREAS";
    private static String SUB_TAG = "---OfflineGroup__frag ";
    public static final String EXTRA_TAB_NAME = "tab_name";

    private View rootView;
    private Button advertise, discover, broadcast, sendMessg,
        bluetoothToggle, radioToggle, wifiToggle;
    private EditText messageText;

    private ChatMessageAdapter messageAdapter;
    private ListView textArea;

    public OfflineGroupFragment() {
        Log.e(TAG, SUB_TAG+"Constructor");
        // Required empty public constructor
    }

    public static OfflineGroupFragment newInstance(String tabName) {
        Log.e(TAG, SUB_TAG+"OfflineGroupFragment");
        Bundle args = new Bundle();
        args.putString(EXTRA_TAB_NAME, tabName);
        OfflineGroupFragment fragment = new OfflineGroupFragment();
        fragment.setArguments(args);
        return fragment;
    }

    @Override
    public void onCreate(Bundle savedInstanceState) {
        Log.e(TAG, SUB_TAG+"onCreate");
        super.onCreate(savedInstanceState);
    }

    @Override
    public View onCreateView(LayoutInflater inflater, ViewGroup container,
                             Bundle savedInstanceState) {
        Log.e(TAG, SUB_TAG+"onCreateView");
        // Inflate the layout for this fragment
        rootView = inflater.inflate(R.layout.activity_chat, container, false);

        Toolbar toolbar = rootView.findViewById(R.id.toolbar);
//        ((AppCompatActivity)getActivity()).setSupportActionBar(toolbar);

        messageAdapter = new ChatMessageAdapter(getActivity().getApplicationContext());
        textArea = (ListView) rootView.findViewById(R.id.chat_textarea);
        textArea.setAdapter(messageAdapter);

        addMessage(true, "Me", "Hello, world!");

        advertise = (Button) rootView.findViewById(R.id.chat_button_bluetooth);
        discover = (Button) rootView.findViewById(R.id.chat_button_radio);
        broadcast = (Button) rootView.findViewById(R.id.chat_button_wifi);

        messageText = (EditText) rootView.findViewById(R.id.chat_messagetext);

        sendMessg = (Button) rootView.findViewById(R.id.send_offline_group_message);
        bluetoothToggle = (Button) rootView.findViewById(R.id.chat_button_bluetooth);
        radioToggle = (Button) rootView.findViewById(R.id.chat_button_radio);
        wifiToggle = (Button) rootView.findViewById(R.id.chat_button_wifi);

        addListenersToButtons();

        return rootView;
    }

    public void addListenersToButtons(){
        Log.e(TAG, SUB_TAG+"Add Listeners for Buttons");
        sendMessg.setOnClickListener(new View.OnClickListener() {
            @Override
            public void onClick(View v) {
                sendOfflineGroupMessage(v);
            }
        });

        bluetoothToggle.setOnClickListener(new View.OnClickListener() {
            @Override
            public void onClick(View v) {
                toggleBluetooth(v);
            }
        });

        radioToggle.setOnClickListener(new View.OnClickListener() {
            @Override
            public void onClick(View v) {
                toggleRadio(v);
            }
        });

        wifiToggle.setOnClickListener(new View.OnClickListener() {
            @Override
            public void onClick(View v) {
                toggleWifi(v);
            }
        });
    }


    public void addMessage(boolean isSelf, String sender, String text){
        Log.e(TAG, SUB_TAG+"add ChatMessage");

        final Message message = new Message(text, sender, isSelf);
        getActivity().runOnUiThread(new Runnable() {
            @Override
            public void run() {
                Log.e(TAG, SUB_TAG+"Thread Run");
                messageAdapter.addMessage(message);
                textArea.setSelection(textArea.getCount() - 1);
            }
        });
    }

    public void toggleBluetooth(View v){
        Log.e(TAG, SUB_TAG+"ToggleBluetooth");
    }

    public void toggleRadio(View v){
        Log.e(TAG, SUB_TAG+"ToggleRadio");
    }

    public void toggleWifi(View v){
        //messageAlgorithm.startBroadcast();
        Log.e(TAG, SUB_TAG+"ToggleWIfi");
    }

    @Override
    public void onStart(){
        Log.e(TAG, SUB_TAG+"onStart");
        super.onStart();
        MainActivity.nearbyConnectionHandler.setActiveActivity(getActivity());
        MainActivity.nearbyConnectionHandler.setActiveFragment(this);
        List<TextMessage> messageList = MainActivity.nearbyConnectionHandler.dequeueGroupChats();
        for(TextMessage mess : messageList){
            addMessage(false, mess.sender.name, mess.message);
        }
    }

    @Override
    public void onStop(){
        Log.e(TAG, SUB_TAG+"onStop");
        MainActivity.nearbyConnectionHandler.removeActiveActivity();
        MainActivity.nearbyConnectionHandler.removeActiveFragment();
        super.onStop();
    }

    public void sendOfflineGroupMessage(View v){
        Log.e(TAG, SUB_TAG+"Sending ChatMessage");
        String msg = messageText.getText().toString();
        Log.e(TAG, SUB_TAG+"Sending message");
        if(msg.equals(""))
            return;

        MainActivity.nearbyConnectionHandler.sendGroupMessage(msg);
        messageText.setText("");
    }

}
