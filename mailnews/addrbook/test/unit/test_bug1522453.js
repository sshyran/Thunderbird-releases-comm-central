var { setTimeout } = ChromeUtils.import("resource://gre/modules/Timer.jsm");

add_task(async function() {
  do_get_profile();
  MailServices.ab.directories;
  let book = MailServices.ab.getDirectory(kPABData.URI);

  let list = Cc["@mozilla.org/addressbook/directoryproperty;1"].createInstance(
    Ci.nsIAbDirectory
  );
  list.isMailList = true;
  list.dirName = "list";
  list = book.addMailList(list);

  let contact1 = Cc["@mozilla.org/addressbook/cardproperty;1"].createInstance(
    Ci.nsIAbCard
  );
  contact1.firstName = "contact";
  contact1.lastName = "1";
  contact1.primaryEmail = "contact1@invalid";
  contact1 = book.addCard(contact1);
  list.addCard(contact1);

  let contact2 = Cc["@mozilla.org/addressbook/cardproperty;1"].createInstance(
    Ci.nsIAbCard
  );
  contact2.firstName = "contact";
  contact2.lastName = "2";
  // No email address!
  contact2 = book.addCard(contact2);
  list.addCard(contact2);

  let contact3 = Cc["@mozilla.org/addressbook/cardproperty;1"].createInstance(
    Ci.nsIAbCard
  );
  contact3.firstName = "contact";
  contact3.lastName = "3";
  contact3.primaryEmail = "contact3@invalid";
  contact3 = book.addCard(contact3);
  list.addCard(contact3);

  // book.childCards should contain the list and all three contacts.
  let bookCards = book.childCards;
  equal(bookCards.length, 1 + 3);
  equal(list.UID, bookCards[0].UID);
  equal(contact1.UID, bookCards[1].UID);
  equal(contact2.UID, bookCards[2].UID);
  equal(contact3.UID, bookCards[3].UID);

  // list.childCards should contain contacts 1 and 3, and crucially, not die at 2.
  let listCards = list.childCards;
  equal(listCards.length, 2);
  equal(contact1.UID, listCards[0].UID);
  equal(contact3.UID, listCards[1].UID);

  // Reload the address book manager.
  Services.obs.notifyObservers(null, "addrbook-reload");
  // Wait for files to close.
  // eslint-disable-next-line mozilla/no-arbitrary-setTimeout
  await new Promise(resolve => setTimeout(resolve, 2000));

  MailServices.ab.directories;
  book = MailServices.ab.getDirectory(kPABData.URI);

  // list.childCards should contain contacts 1 and 3.
  listCards = list.childCards;
  equal(listCards.length, 2);
  equal(contact1.UID, listCards[0].UID);
  equal(contact3.UID, listCards[1].UID);
});
