package com.sjsu.boreas.Misc;

import android.widget.ImageButton;

import java.util.ArrayList;

public class AppBarButtonsHandler {
    private ArrayList<ImageButton> list = new ArrayList<>();
    private int lastSelected = 0;

    public AppBarButtonsHandler(int defaultPosition) {
        lastSelected = defaultPosition;
    }

    public void setState(int position) {
        if (position == lastSelected) return;
        list.get(position).setAlpha((float) 1.0);
        list.get(lastSelected).setAlpha((float) 0.4);
        lastSelected = position;
    }

    public void addButton(ImageButton b) {
        list.add(b);
        if(!(list.size()-1==lastSelected)) b.setAlpha((float) 0.4);
    }
}
