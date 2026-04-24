package com.sjsu.boreas.Security;

import android.content.Context;
import android.util.Base64;
import android.util.Log;
import android.widget.Toast;

import com.sjsu.boreas.Database.Contacts.User;
import com.sjsu.boreas.Database.Messages.ChatMessage;
import com.sjsu.boreas.MainActivity;
import com.sjsu.boreas.Misc.ContextHelper;

import java.io.UnsupportedEncodingException;
import java.security.InvalidKeyException;
import java.security.KeyFactory;
import java.security.KeyPair;
import java.security.KeyPairGenerator;
import java.security.NoSuchAlgorithmException;
import java.security.PrivateKey;
import java.security.PublicKey;
import java.security.spec.EncodedKeySpec;
import java.security.spec.InvalidKeySpecException;
import java.security.spec.PKCS8EncodedKeySpec;
import java.security.spec.X509EncodedKeySpec;

import javax.crypto.BadPaddingException;
import javax.crypto.Cipher;
import javax.crypto.IllegalBlockSizeException;
import javax.crypto.NoSuchPaddingException;

public class EncryptionController {
    private static EncryptionController instance;
    private static String TAG = "BOREAS";
    private static String SUB_TAG = "----------------EncryptionController ";
    private static Context mContext;

    public static EncryptionController getInstance(){
        if(instance == null){
            instance = new EncryptionController();
            mContext = ContextHelper.get().getApplicationContext();
            return instance;
        }
        else return instance;
    }

    // generateKey() source: https://gist.githubusercontent.com/liudong/3993726/raw/e8c3e2309710a7da797dad61de987e4f6484a14c/gistfile1.java
    public String[] generateKeys(String keyAlgorithm, int numBits) {
        String[] keypair = new String[2];
        try {
            // Get the public/private key pair
            KeyPairGenerator keyGen = KeyPairGenerator.getInstance(keyAlgorithm);
            keyGen.initialize(numBits);
            KeyPair keyPair = keyGen.genKeyPair();

            PrivateKey privateKey = keyPair.getPrivate();
            PublicKey publicKey = keyPair.getPublic();

            keypair[0] = Base64.encodeToString(privateKey.getEncoded(), Base64.DEFAULT); //0 private
            keypair[1] = Base64.encodeToString(publicKey.getEncoded(), Base64.DEFAULT);//1 public

        } catch (NoSuchAlgorithmException e) {
            Log.e(TAG, SUB_TAG + "Exception. No such algorithm: " + keyAlgorithm);
        } catch (Exception e){
            Log.e(TAG, SUB_TAG + "Exception. See the following error stack: " + e);
        }
        return keypair;
    }

    public ChatMessage getEncryptedMessage(ChatMessage m){
        ChatMessage message = new ChatMessage(m);
        try {
            User recipient = message.recipient;
            Log.e(TAG, SUB_TAG+" encryptor: initializing cipher");
            Cipher cipher = Cipher.getInstance("RSA/ECB/PKCS1Padding");

            Log.e(TAG, SUB_TAG+" encryptor: initializing spec");
            X509EncodedKeySpec keySpec = new X509EncodedKeySpec(Base64.decode(message.recipient.publicKey, Base64.DEFAULT));

            Log.e(TAG, SUB_TAG+" encryptor: initializing keyfactory");
            KeyFactory fac = KeyFactory.getInstance("RSA");

            Log.e(TAG, SUB_TAG+" encryptor: cipher.init()");
            cipher.init(Cipher.ENCRYPT_MODE, fac.generatePublic(keySpec));

            Log.e(TAG, SUB_TAG+" encryptor: encrypt text.. \n" + message.mssgText);
            message.mssgText = Base64.encodeToString(cipher.doFinal(message.mssgText.getBytes("UTF-8")), Base64.DEFAULT);
            message.isEncrypted = true;
            Log.e(TAG, SUB_TAG+" encryptor: encrypted text.. \n" + message.mssgText);
        }catch (NoSuchAlgorithmException e){
            Log.e(TAG, SUB_TAG+ "Error encrypting: Could not encrypt text- RSA alg not found. \nerror:"+e);
            e.printStackTrace();
        }
        catch (NoSuchPaddingException e){
            Log.e(TAG, SUB_TAG+ "Error encrypting: Could not encrypt text- Padding alg not found. \nerror:"+e);
            e.printStackTrace();
        }
        catch (InvalidKeySpecException | InvalidKeyException e){
            Log.e(TAG, SUB_TAG+ "Error encrypting: Could not parse recipient's key. \nerror:"+e);
            e.printStackTrace();
        }
        catch (UnsupportedEncodingException | BadPaddingException | IllegalBlockSizeException e){
            Log.e(TAG, SUB_TAG+ "Error encrypting: Could not perform encryption. \nerror:"+e);
            e.printStackTrace();
        }catch (Exception e){
            Log.e(TAG, SUB_TAG+ "Error encrypting: Unknown encryption. See the following message.\nerror: " + e);
        }

        return message;
    }

    public ChatMessage getDecryptedMessage(ChatMessage m){
        ChatMessage message = new ChatMessage(m);
        try {
            Log.e(TAG, SUB_TAG+" decryptor: initializing cipher");
            Cipher cipher = Cipher.getInstance("RSA/ECB/PKCS1Padding");

            Log.e(TAG, SUB_TAG+" decryptor: initializing spec");
            PKCS8EncodedKeySpec keySpec = new PKCS8EncodedKeySpec(Base64.decode(MainActivity.currentUser.privateKey, Base64.DEFAULT));

            Log.e(TAG, SUB_TAG+" decryptor: initializing keyfactory");
            KeyFactory fac = KeyFactory.getInstance("RSA");

            Log.e(TAG, SUB_TAG+" decryptor: cipher.init()");
            cipher.init(Cipher.DECRYPT_MODE, fac.generatePrivate(keySpec));

            Log.e(TAG, SUB_TAG+" decryptor: decrypting text.. \n" + message.mssgText);
            message.mssgText = new String(cipher.doFinal(Base64.decode(message.mssgText, Base64.DEFAULT)), "UTF-8");
            message.isEncrypted = false;
            Log.e(TAG, SUB_TAG+" decryptor: decrypted text.. \n" + message.mssgText );
        }catch (NoSuchAlgorithmException e){
            Log.e(TAG, SUB_TAG+ "Error decrypting: Could not encrypt text- RSA alg not found"+ "error: " + e);
            e.printStackTrace();
        }catch (NoSuchPaddingException e){
            Log.e(TAG, SUB_TAG+ "Error decrypting: Could not encrypt text- Padding alg not found"+ "error: " + e);
            e.printStackTrace();
        }catch (InvalidKeySpecException | InvalidKeyException e){
            Log.e(TAG, SUB_TAG+ "Error decrypting: Could not parse recipient's key"+ "error: " + e);
            e.printStackTrace();
        }catch (UnsupportedEncodingException | BadPaddingException | IllegalBlockSizeException e){
            Log.e(TAG, SUB_TAG+ "Error decrypting: Could not perform encryption"+ "error: " + e);
            e.printStackTrace();
        }catch (Exception e){
            Log.e(TAG, SUB_TAG+ "Error decrypting: Unknown error. See the following message.\nerror: " + e);
        }
        return message;
    }
}
