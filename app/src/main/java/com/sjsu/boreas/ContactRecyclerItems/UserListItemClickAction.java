package com.sjsu.boreas.ContactRecyclerItems;

import com.sjsu.boreas.Database.Contacts.User;

public interface UserListItemClickAction {
    public void onItemClicked(User model, int position);
}
