package com.sjsu.boreas.PhoneBluetoothRadio;

/*
 * Copyright (C) 2009 The Android Open Source Project
 *
 * Licensed under the Apache License, Version 2.0 (the "License");
 * you may not use this file except in compliance with the License.
 * You may obtain a copy of the License at
 *
 *      http://www.apache.org/licenses/LICENSE-2.0
 *
 * Unless required by applicable law or agreed to in writing, software
 * distributed under the License is distributed on an "AS IS" BASIS,
 * WITHOUT WARRANTIES OR CONDITIONS OF ANY KIND, either express or implied.
 * See the License for the specific language governing permissions and
 * limitations under the License.
 */

import android.bluetooth.BluetoothAdapter;
import android.bluetooth.BluetoothDevice;
import android.bluetooth.BluetoothSocket;
import android.os.AsyncTask;
import android.os.Bundle;
import android.util.Log;

import com.sjsu.boreas.Database.LocalDatabaseReference;
import com.sjsu.boreas.Database.Messages.ChatMessage;
import com.sjsu.boreas.Database.Messages.MessageUtility;
import com.sjsu.boreas.Events.Event;
import com.sjsu.boreas.Misc.ContextHelper;

import java.io.IOException;
import java.io.InputStream;
import java.io.OutputStream;
import java.io.UnsupportedEncodingException;
import java.lang.reflect.Method;
import java.util.ArrayList;
import java.util.UUID;

/**
 * This class does all the work for setting up and managing Bluetooth
 * connections with other devices. It has a thread that listens for
 * incoming connections, a thread for connecting with a device, and a
 * thread for performing data transmissions when connected.
 */
public class BluetoothSerialService {
    // Debugging
    private static final String TAG = "BOREAS";
    private static final String SUB_TAG = "------BluetoothSErialService ";
    private static final boolean D = true;


    private static final UUID SerialPortServiceClass_UUID = UUID.fromString("00001101-0000-1000-8000-00805F9B34FB");

    // Member fields
    private final BluetoothAdapter mAdapter;
    //    private final Handler mHandler;
    private ConnectThread mConnectThread;
    private ConnectedThread mConnectedThread;
    private int mState;

    private boolean mAllowInsecureConnections;

//    private EmulatorView mEmulatorView;
//    private Context mContext;

    // Constants that indicate the current connection state
    public static final int STATE_NONE = 0;       // we're doing nothing
    public static final int STATE_LISTEN = 1;     // now listening for incoming connections
    public static final int STATE_CONNECTING = 2; // now initiating an outgoing connection
    public static final int STATE_CONNECTED = 3;  // now connected to a remote device

    //Use radio events to update listeners
    private Event event_radio_connected = Event.get(Event.radioConnected);
    private Event event_radio_disconnected = Event.get(Event.radioDisconnected);

    private ContextHelper contextHelper = ContextHelper.get();

    private String radio_pckg_list_str = "";

    private LocalDatabaseReference localDatabaseReference = LocalDatabaseReference.get();


    /**
     * Constructor. Prepares a new BluetoothChat session.
     //     * @param context  The UI Activity Context
     //     * @param handler  A Handler to send messages back to the UI Activity
     */
    public BluetoothSerialService() {
        mAdapter = BluetoothAdapter.getDefaultAdapter();
        mState = STATE_NONE;
//        mHandler = handler;
//        mEmulatorView = emulatorView;
//        mContext = context;
        mAllowInsecureConnections = true;
    }

    /**
     * Set the current state of the chat connection
     * @param state  An integer defining the current connection state
     */
    private synchronized void setState(int state) {
        if (D) Log.d(TAG, SUB_TAG+"setState() " + mState + " -> " + state);
        mState = state;

        // Give the new state to the Handler so the UI Activity can update
//        mHandler.obtainMessage(BlueTerm.MESSAGE_STATE_CHANGE, state, -1).sendToTarget();
    }

    /**
     * Return the current connection state. */
    public synchronized int getState() {
        return mState;
    }

    /**
     * Start the chat service. Specifically start AcceptThread to begin a
     * session in listening (server) mode. Called by the Activity onResume() */
    public synchronized void start() {
        if (D) Log.d(TAG, SUB_TAG+"start");

        // Cancel any thread attempting to make a connection
        if (mConnectThread != null) {
            mConnectThread.cancel();
            mConnectThread = null;
        }

        // Cancel any thread currently running a connection
        if (mConnectedThread != null) {
            mConnectedThread.cancel();
            mConnectedThread = null;
        }

        setState(STATE_NONE);
    }

    /**
     * Start the ConnectThread to initiate a connection to a remote device.
     * @param device  The BluetoothDevice to connect
     */
    public synchronized void connect(BluetoothDevice device) {
        if (D) Log.d(TAG, SUB_TAG+"connect to: " + device);

        // Cancel any thread attempting to make a connection
        if (mState == STATE_CONNECTING) {
            if (mConnectThread != null) {mConnectThread.cancel(); mConnectThread = null;}
        }

        // Cancel any thread currently running a connection
        if (mConnectedThread != null) {mConnectedThread.cancel(); mConnectedThread = null;}

        // Start the thread to connect with the given device
        mConnectThread = new ConnectThread(device);
        mConnectThread.start();
        setState(STATE_CONNECTING);
    }

    /**
     * Start the ConnectedThread to begin managing a Bluetooth connection
     * @param socket  The BluetoothSocket on which the connection was made
     * @param device  The BluetoothDevice that has been connected
     */
    public synchronized void connected(BluetoothSocket socket, BluetoothDevice device) {
        if (D) Log.d(TAG, SUB_TAG+"connected");

        // Cancel the thread that completed the connection
        if (mConnectThread != null) {
            mConnectThread.cancel();
            mConnectThread = null;
        }

        // Cancel any thread currently running a connection
        if (mConnectedThread != null) {
            mConnectedThread.cancel();
            mConnectedThread = null;
        }

        // Start the thread to manage the connection and perform transmissions
        mConnectedThread = new ConnectedThread(socket);
        mConnectedThread.start();

        // Send the name of the connected device back to the UI Activity
//        Message msg = mHandler.obtainMessage(BlueTerm.MESSAGE_DEVICE_NAME);
        Bundle bundle = new Bundle();
        if(device != null)
            bundle.putString(BlueTerm.DEVICE_NAME, device.getName());
//        msg.setData(bundle);
//        mHandler.sendMessage(msg);

        setState(STATE_CONNECTED);
    }

    /**
     * Stop all threads
     */
    public synchronized void stop() {
        if (D) Log.d(TAG, SUB_TAG+"stop");


        if (mConnectThread != null) {
            mConnectThread.cancel();
            mConnectThread = null;
        }

        if (mConnectedThread != null) {
            mConnectedThread.cancel();
            mConnectedThread = null;
        }

        setState(STATE_NONE);
    }

    /**
     * Write to the ConnectedThread in an unsynchronized manner
     * @param out The bytes to write
     * @see ConnectedThread#write(byte[])
     */
    public void write(byte[] out) throws UnsupportedEncodingException {
        Log.e(TAG, SUB_TAG+"Sending message, final step.");
        // Create temporary object
        ConnectedThread r;
        // Synchronize a copy of the ConnectedThread
        synchronized (this) {
            if (mState != STATE_CONNECTED) return;
            r = mConnectedThread;
        }
        // Perform the write unsynchronized
        r.write(out);
    }

    /**
     * Indicate that the connection attempt failed and notify the UI Activity.
     */
    private void connectionFailed() {
        Log.e(TAG, SUB_TAG + "Connection failed");
        setState(STATE_NONE);
        event_radio_disconnected.trigger(null);

        // Send a failure message back to the Activity
//        Message msg = mHandler.obtainMessage(BlueTerm.MESSAGE_TOAST);
//        Bundle bundle = new Bundle();
////        bundle.putString(BlueTerm.TOAST, mContext.getString(R.string.toast_unable_to_connect) );
//        msg.setData(bundle);
//        mHandler.sendMessage(msg);
    }

    /**
     * Indicate that the connection was lost and notify the UI Activity.
     */
    private void connectionLost() {
        Log.e(TAG, SUB_TAG+"Connection lost");
        setState(STATE_NONE);

        // Send a failure message back to the Activity
//        Message msg = mHandler.obtainMessage(BlueTerm.MESSAGE_TOAST);
//        Bundle bundle = new Bundle();
////        bundle.putString(BlueTerm.TOAST, mContext.getString(R.string.toast_connection_lost) );
//        msg.setData(bundle);
//        mHandler.sendMessage(msg);
    }

    /**
     * This thread runs while attempting to make an outgoing connection
     * with a device. It runs straight through; the connection either
     * succeeds or fails.
     */
    private class ConnectThread extends Thread {
        private final BluetoothSocket mmSocket;
        private final BluetoothDevice mmDevice;

        public ConnectThread(BluetoothDevice device) {
            mmDevice = device;
            BluetoothSocket tmp = null;

            // Get a BluetoothSocket for a connection with the
            // given BluetoothDevice
            try {
                if ( mAllowInsecureConnections ) {
                    Method method;
                    if(device != null) {
                        Log.e(TAG, device.getName());
                        method = device.getClass().getMethod("createRfcommSocket", new Class[]{int.class});
                        tmp = (BluetoothSocket) method.invoke(device, 1);
                    }
                }
                else {
                    tmp = device.createRfcommSocketToServiceRecord( SerialPortServiceClass_UUID );
                }
            } catch (Exception e) {
                Log.e(TAG, SUB_TAG+"create() failed", e);
            }
            mmSocket = tmp;
        }

        public void run() {
            Log.e(TAG, SUB_TAG+"BEGIN mConnectThread");
            setName("ConnectThread");

            // Always cancel discovery because it will slow down a connection
            mAdapter.cancelDiscovery();

            // Make a connection to the BluetoothSocket
            try {
                // This is a blocking call and will only return on a
                // successful connection or an exception

                if(mmSocket != null) {
                    Log.e(TAG, SUB_TAG + "outter try of connect thread");
                    event_radio_connected.trigger(null);
                    mmSocket.connect();
                }
            } catch (IOException e) {
                connectionFailed();
                // Close the socket
                try {
                    Log.e(TAG, SUB_TAG + "outter catch clause of run of connect thread: " + e);
                    mmSocket.close();
                } catch (IOException e2) {
                    Log.e(TAG, SUB_TAG+"unable to close() socket during connection failure", e2);
                }
                // Start the service over to restart listening mode
                //BluetoothSerialService.this.start();
                return;
            }

            // Reset the ConnectThread because we're done
            synchronized (BluetoothSerialService.this) {
                mConnectThread = null;
            }

            Log.e(TAG, SUB_TAG+"Connected Thread starting");
            // Start the connected thread
            connected(mmSocket, mmDevice);
        }

        public void cancel() {
            try {
                mmSocket.close();
            } catch (IOException e) {
                Log.e(TAG, SUB_TAG+"close() of connect socket failed", e);
            }
        }
    }

    /**
     * This thread runs during a connection with a remote device.
     * It handles all incoming and outgoing transmissions.
     */
    private class ConnectedThread extends Thread {
        private final BluetoothSocket mmSocket;
        private final InputStream mmInStream;
        private final OutputStream mmOutStream;


        public ConnectedThread(BluetoothSocket socket) {
            Log.e(TAG, "create ConnectedThread");
            mmSocket = socket;
            InputStream tmpIn = null;
            OutputStream tmpOut = null;

            // Get the BluetoothSocket input and output streams
            try {
                if(socket != null) {
                    tmpIn = socket.getInputStream();
                    tmpOut = socket.getOutputStream();
                }
            } catch (IOException e) {
                Log.e(TAG, SUB_TAG+"temp sockets not created", e);
            }

            mmInStream = tmpIn;
            mmOutStream = tmpOut;
        }

        public void run() {
            Log.e(TAG, SUB_TAG+"BEGIN mConnectedThread");
            byte[] buffer = new byte[200];
            int bytes;

            String chat_mssg_str = "";

            // Keep listening to the InputStream while connected
            while (true) {
                Log.e(TAG, SUB_TAG+"Listening for incoming mssgs.");
                try {
                    // Read from the InputStream
                    if(mmInStream != null) {
                        Log.e(TAG, "Reading mmInStream buffer");
                        bytes = mmInStream.read(buffer);
//                    mEmulatorView.write(buffer, bytes);
                        // Send the obtained bytes to the UI Activity
                        //mHandler.obtainMessage(BlueTerm.MESSAGE_READ, bytes, -1, buffer).sendToTarget();
                        String str = new String(buffer, "UTF-8").trim() + '\0'; // for UTF-8 encoding
//                        Log.e(TAG, "\t\tReceived: " + str);
//                        RadioPackage.parseAllPackages(str);

                        if(str.substring(0,4).equals("DONE")){
                            Log.e(TAG, SUB_TAG+"Done recieved ---=-=-=-=-=_+_+_+-=-=_+_=-+_=_+_\n\n\n" + radio_pckg_list_str);
                            RadioPackage.parseAllPackages(radio_pckg_list_str);
                        }
                        else {
                            radio_pckg_list_str = radio_pckg_list_str + str;
//                            chat_mssg_str = chat_mssg_str + radioPackage.packg_data;
//                            if(radioPackage != null) {
//                                Log.e(TAG, SUB_TAG+"*****************************");
//                                Log.i(TAG, SUB_TAG+"*****************************");
//                                radio_pckg_list.add(radioPackage);
//                            }
                        }

//                        ChatMessage mssg = MessageUtility.convertJsonToMessage(str.substring(0,bytes));
//                        if(mssg != null)
//                            ChatMessage.notifyListener(mssg);
//                        else
//                            Log.e(TAG, SUB_TAG+"[[[[[[[[[[[[[[[[[[[[[[[[[[[[[The chat mssg returned was null bruh -------------------");
                    }else{
                        Log.e(TAG, "mmInstream is null");
                        Log.i(TAG, "mmInstream is null");
                    }
                } catch (IOException e) {
                    Log.e(TAG, SUB_TAG+"disconnected", e);
//                    RadioPackage.sortOutThePackagesReceived(mssges_received);
                    connectionLost();
                    break;
                }
            }
        }

        /**
         * Write to the connected OutStream.
         * @param buffer  The bytes to write
         */
        public void write(byte[] buffer) throws UnsupportedEncodingException {
            String str = new String(buffer, "US-ASCII");
            Log.i(TAG, SUB_TAG+"Sent: " + str);
            try {
                mmOutStream.write(buffer);

                // Share the sent message back to the UI Activity
//                mHandler.obtainMessage(BlueTerm.MESSAGE_WRITE, buffer.length, -1, buffer).sendToTarget();
            } catch (IOException e) {
                Log.e(TAG, SUB_TAG+"Exception during write", e);
            }
        }

        public void cancel() {
            try {
                mmSocket.close();
            } catch (IOException e) {
                Log.e(TAG, SUB_TAG+"close() of connect socket failed", e);
            }
        }
    }

    public void setAllowInsecureConnections( boolean allowInsecureConnections ) {
        mAllowInsecureConnections = allowInsecureConnections;
    }

    public boolean getAllowInsecureConnections() {
        return mAllowInsecureConnections;
    }


}


