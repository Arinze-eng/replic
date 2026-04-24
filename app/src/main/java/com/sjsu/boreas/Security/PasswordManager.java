package com.sjsu.boreas.Security;

import android.util.Log;

import java.security.MessageDigest;
import java.security.NoSuchAlgorithmException;

public class PasswordManager {

    private static String TAG = "BOREAS";
    private static String SUB_TAG = "-------Security-Stuff-- ";

    public static String hashThePassword(String password){
        Log.e(TAG, SUB_TAG+"Hashing the provided password");

        MessageDigest messageDigest = null;
        try {
            messageDigest = MessageDigest.getInstance("SHA-256");
        } catch (NoSuchAlgorithmException e) {
            e.printStackTrace();
        }
        messageDigest.update(password.getBytes());
        String encryptedString = new String(messageDigest.digest());

        return encryptedString;
    }
}
