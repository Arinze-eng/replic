package com.sjsu.boreas.PhoneBluetoothRadio;

import android.bluetooth.BluetoothAdapter;
import android.bluetooth.BluetoothDevice;
import android.os.AsyncTask;
import android.util.Log;

import com.sjsu.boreas.Database.Messages.ChatMessage;

import java.io.UnsupportedEncodingException;
import java.nio.charset.Charset;
import java.util.ArrayList;
import java.util.Set;


public class BlueTerm{

    private static String TAG = "BOREAS";
    private static String SUB_TAG = "-----Blueterm";

    private static BluetoothAdapter mBluetoothAdapter = BluetoothAdapter.getDefaultAdapter();
    private static BluetoothSerialService mSerialService;
    private static BluetoothDevice default_device_pi;

    public static String default_bluetooth_device_name = "raspberrypi";

    // Message types sent from the BluetoothReadService Handler
    public static final int MESSAGE_STATE_CHANGE = 1;
    public static final int MESSAGE_READ = 2;
    public static final int MESSAGE_WRITE = 3;
    public static final int MESSAGE_DEVICE_NAME = 4;
    public static final int MESSAGE_TOAST = 5;

    // Key names received from the BluetoothChatService Handler
    public static String DEVICE_NAME = default_bluetooth_device_name;
    public static final String TOAST = "toast";


    public static void setDefaultDeviceName(String deviceName){
        Log.e(TAG, SUB_TAG+"Setting device name");
        default_bluetooth_device_name = deviceName;
    }

    public BlueTerm() {
        Log.e(TAG, SUB_TAG+ "+++ Constructor+++");
    }

    private static BluetoothDevice getBluetoothDeviceWithName(String name){
        BluetoothDevice temp = null;

        Log.e(TAG, SUB_TAG+"get blue tooth device: " + name);
        Set<BluetoothDevice> devices = mBluetoothAdapter.getBondedDevices();

        //If no name is given then fall back to the default device name
        if(name != null && !(name.isEmpty()))
            DEVICE_NAME = default_bluetooth_device_name;

        for (BluetoothDevice device : devices) {
            Log.e(TAG, "\n  Device: " + device.getName() + ", " + device.getAddress());
            if(device.getName().equals(DEVICE_NAME)) {
                temp = device;
            }
        }

        Log.e(TAG, SUB_TAG+temp.getName());
        return temp;
    }

    //This function connects to whatever device name which is in default_bluetooth_device_name variable
    private static boolean connectToBluetoothDevice(){
        Log.e(TAG, SUB_TAG+"connected to blth function");
        if (mBluetoothAdapter == null) {
            Log.e(TAG, SUB_TAG+"This device doesn't have bluetooth.");
            return false;
        }

        default_device_pi = getBluetoothDeviceWithName(default_bluetooth_device_name);
        mSerialService = new BluetoothSerialService();

        Log.e(TAG, "+++ DONE IN ON CREATE +++");

        //Get the rasperry pi

        mSerialService.connect(default_device_pi);
        //TODO:need better check here for whether the connection is actually established
        return true;
    }

    public static boolean getSerialConnectionStatus(){
        Log.e(TAG, SUB_TAG+"Check if a serial connection is established");
        if(mSerialService == null || mSerialService.getState() != BluetoothSerialService.STATE_CONNECTED){
            Log.e(TAG, SUB_TAG+"The device isn't connected to anything yet, gonna try to change that and connect to: " + default_bluetooth_device_name);
            return connectToBluetoothDevice();
        }
        return false;
    }

    //This function is the one that sends the data out
    private static void sendByte(final byte[] out){
        Log.e(TAG, SUB_TAG+"Sending mssg");

        if(!getSerialConnectionStatus()){
            Log.e(TAG, SUB_TAG + "No radio connected, please try again");
            return;
        }

        Log.e(TAG, SUB_TAG+"Serial state is: "+ mSerialService.getState());

        AsyncTask.execute(new Runnable() {
            @Override
            public void run() {
                Log.e(TAG, SUB_TAG+"Send the data inside this thread");
                while(mSerialService != null && mSerialService.getState() != BluetoothSerialService.STATE_CONNECTED) {
                    try {
                        Thread.sleep(1000);
                    } catch (InterruptedException e) {
                        e.printStackTrace();
                    }
                }
                if (out.length > 0) {
                    try {
                        mSerialService.write(out);
                    } catch (UnsupportedEncodingException e) {
                        e.printStackTrace();
                    }
                }
            }
        });
    }

    //Change device name
    public static void connectToSpecificDevice(String name){
        default_bluetooth_device_name = name;
        connectToBluetoothDevice();
    }

    //This function is the function which will b used by outside classes to send stuff using radio
    public static void sendMessage(ChatMessage chatMessage) {
        Log.e(TAG, SUB_TAG+"getting ready to send mssg");

        if(chatMessage == null) {
            Log.e(TAG, SUB_TAG+"Chatmessage empty yo, what the heck yo?");
            return;
        }

        if(chatMessage.mssgType == ChatMessage.ChatTypes.GETMESSAGESFROMRADIO.getValue()){
            Log.e(TAG, SUB_TAG+"Calling the radio and asking for your mssgs yo");
            final String ANYTHINGFORME = "ANYTHINGFORME";
            sendByte(ANYTHINGFORME.getBytes(Charset.forName("UTF-8")));
            return;
        }

        ArrayList<RadioPackage> radio_packgs_to_send = RadioPackage.getRadioPackgsToSend(chatMessage);

        int radio_packgs_list_len = radio_packgs_to_send.size();
        for(int i = 0; i < radio_packgs_list_len; i++){
            String radio_packg_str = radio_packgs_to_send.get(i).toString();
            sendByte(radio_packg_str.getBytes(Charset.forName("UTF-8")));
        }
        final String DONE = "DONE";
        sendByte(DONE.getBytes(Charset.forName("UTF-8")));
    }
}
