package com.sjsu.boreas.ChatView.MediaFilesRecyclerItems;

import android.graphics.Bitmap;
import android.graphics.BitmapFactory;
import android.net.Uri;
import android.os.Environment;
import android.util.Base64;
import android.util.Log;

import androidx.appcompat.view.menu.SubMenuBuilder;
import androidx.room.ColumnInfo;
import androidx.room.Entity;

import com.sjsu.boreas.Database.Messages.ChatMessage;
import com.sjsu.boreas.Misc.ContextHelper;

import java.io.BufferedReader;
import java.io.ByteArrayInputStream;
import java.io.ByteArrayOutputStream;
import java.io.File;
import java.io.FileNotFoundException;
import java.io.FileOutputStream;
import java.io.IOException;
import java.io.InputStream;
import java.io.InputStreamReader;
import java.security.spec.ECField;
import java.util.zip.GZIPInputStream;
import java.util.zip.GZIPOutputStream;

public class FileItem {

    private static String TAG = "BOREAS";
    private static String SUB_TAG = "-----------FileItem-- ";
//    public String date;

    private Uri picUri;
    private Bitmap pic;

    public FileItem(String picPath){
        this.picUri.fromFile(new File(picPath));

        //Create the thumbnail
        final int THUMBNAIL_SIZE = 246;
        this.pic = BitmapFactory.decodeFile(picPath);
//        this.pic = Bitmap.createScaledBitmap(this.pic, THUMBNAIL_SIZE, THUMBNAIL_SIZE, false);

        this.picUri = Uri.fromFile(new File(picPath));
    }

    public Bitmap getPic(){ return pic;}
    public Uri getPicUri(){ return picUri;}

    public static String picBitmapToString(Bitmap pic_bitmap){
        Log.e(TAG,SUB_TAG+"\n\tBit map to string");
        String pic_str_data = "";
        ByteArrayOutputStream baos=new  ByteArrayOutputStream();
        pic_bitmap.compress(Bitmap.CompressFormat.PNG,100, baos);
        byte [] b=baos.toByteArray();
        pic_str_data= Base64.encodeToString(b, Base64.DEFAULT);
        return pic_str_data;
    }

    public static Bitmap stringToBitMap(String encodedString){
        Log.e(TAG, SUB_TAG+"\n\tString to bit map");
        try {
            byte [] encodeByte=Base64.decode(encodedString,Base64.DEFAULT);
            Bitmap bitmap=BitmapFactory.decodeByteArray(encodeByte, 0, encodeByte.length);
            return bitmap;
        } catch(Exception e) {
            e.getMessage();
            return null;
        }
    }

    public static byte[] compress(String str) {
        Log.e(TAG, SUB_TAG+"Compressing");
        if (str == null || str.length() == 0) {
            return "".getBytes();
        }
        try {
            ByteArrayOutputStream out = new ByteArrayOutputStream();
            GZIPOutputStream gzip = new GZIPOutputStream(out);
            gzip.write(str.getBytes("UTF-8"));
            gzip.close();
            return out.toByteArray();
        }
        catch (Exception e){
            Log.e(TAG, SUB_TAG+"Exception: " + e);
            return null;
        }
    }

    public static String decompress(byte[] str){
        Log.e(TAG, SUB_TAG+"Decompressing");
        if (str == null) {
            return null;
        }

        try {
            GZIPInputStream gis = new GZIPInputStream(new ByteArrayInputStream(str));
            BufferedReader bf = new BufferedReader(new InputStreamReader(gis, "UTF-8"));
            String outStr = "";
            String line;
            Log.e(TAG, SUB_TAG+"Inside the loop");
            while ((line = bf.readLine()) != null) {
                outStr += line;
            }
            Log.e(TAG, SUB_TAG + "Output String lenght : " + outStr.length());
            return outStr;
        }
        catch (Exception e){
            Log.e(TAG, SUB_TAG+"Exception: " + e);
            return null;
        }
    }

    public static String saveImageAndGetUri(ChatMessage message){
        Log.e(TAG, SUB_TAG+"Saving the image and getting the uri");
        String uri = "";

        Bitmap bitmap = stringToBitMap(message.imgData);

        try {
            ContextHelper contextHelper = ContextHelper.get();
            File path = new File(contextHelper.getApplicationContext().getFilesDir(), "Boreas" + File.separator + "Images");
            if(!path.exists()){
                path.mkdirs();
            }
            File outFile = new File(path, message.time + ".jpeg");
            FileOutputStream outputStream = new FileOutputStream(outFile);
            bitmap.compress(Bitmap.CompressFormat.JPEG, 100, outputStream);
            outputStream.close();
            uri = Uri.fromFile(outFile).toString();
        } catch (FileNotFoundException e) {
            Log.e(TAG, "Saving received message failed with", e);
        } catch (IOException e) {
            Log.e(TAG, "Saving received message failed with", e);
        }

        return uri;
    }
}
