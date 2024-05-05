import json
import requests
import zipfile
import os
import sys
import shutil
import re

ADDON_PATH = "/run/media/gianluca/7954e2ae-6c95-457b-9f0a-5f9e03a996a4/steam/steamapps/compatdata/306130/pfx/drive_c/users/steamuser/Documents/Elder Scrolls Online/live/AddOns/"
FILELIST_PATH = os.path.join(ADDON_PATH, "filelist.json")
INSTALLED_ADDONS_PATH = os.path.join(ADDON_PATH, "installed_addons.json")
CONFIG_INSTALL_DEPS = True

def download_filelist():
    response = requests.get("https://api.mmoui.com/v3/game/ESO/filelist.json")
    
    if response.status_code == 200:
        with open(FILELIST_PATH, 'wb') as file:
            file.write(response.content)
        print("File downloaded successfully.")
    else:
        print("Failed to download file. Status code:", response.status_code)

def search_json_file(searchtext):
    with open(FILELIST_PATH, 'r') as file:
        data = json.load(file)

    # TODO: ignore spaces, ignore "'". Example "Elm's Markers" shall be found by "elmsmarkers" or "ExecuteNow" by "execute now"

    searchtext_lower = searchtext.lower()
    matches = []
    for index, item in enumerate(data):
        ui_name_lower = item["UIName"].lower()
        if searchtext_lower in ui_name_lower:
            matches.append(index)

    return matches

def get_file_info(index):
    with open("filelist.json", 'r') as file:
        data = json.load(file)

    if index < 0 or index >= len(data):
        return "Index out of range"

    file_info = {
        "UID": data[index]["UID"],
        "UIVersion": data[index]["UIVersion"],
        "UIDate": data[index]["UIDate"],
        "UIName": data[index]["UIName"],
        "UIAuthorName": data[index]["UIAuthorName"],
        "UIDownloadTotal": data[index]["UIDownloadTotal"]
    }

    return file_info

def download_and_extract_zip(id):
    local_zip_path = "downloaded_file.zip"
    url = "https://www.esoui.com/downloads/getfile.php?id=" + str(id)

    print("Downloading AddOn...")
    response = requests.get(url)

    if response.status_code != 200:
        raise Exception(f"Failed to download file: HTTP {response.status_code}")

    if 'application/zip' not in response.headers.get('Content-Type', ''):
        raise Exception("The downloaded file is not a zip file.")

    with open(local_zip_path, 'wb') as f:
        f.write(response.content)
    
    print("Installing AddOn...")

    try:
        with zipfile.ZipFile(local_zip_path, 'r') as zip_ref:
            zip_ref.extractall(ADDON_PATH)
            dir = zip_ref.namelist()[0].split('/')[0]
    except zipfile.BadZipFile:
        raise Exception("Failed to extract, the downloaded file is not a valid zip file.")

    os.remove(local_zip_path)
    print("AddOn successfully installed.")
    return dir

def update():
    with open(INSTALLED_ADDONS_PATH, 'r') as file:
        installed_addons = json.load(file)

    with open(FILELIST_PATH, 'r') as file:
        file_list = json.load(file)

    for installed_addon in installed_addons:
        for file_entry in file_list:
            if installed_addon["UID"] == file_entry["UID"]:
                installed_version = int(installed_addon["UIDate"])
                file_version = int(file_entry["UIDate"])

                if file_version > installed_version:
                    print("updating " + installed_addon["UIName"])
                    dir = download_and_extract_zip(installed_addon["UID"])
                    installed_addon["Directory"] = dir
                    installed_addon["UIName"] = file_entry["UIName"]
                    installed_addon["UIVersion"] = file_entry["UIVersion"]
                    installed_addon["UIDate"] = file_entry["UIDate"]
                    installed_addon["UIAuthorName"] = file_entry["UIAuthorName"]
                    installed_addon["UIDownloadTotal"] = file_entry["UIDownloadTotal"]
                    store_installed_addon(installed_addon)
                break

def store_installed_addon(file_info):
    try:
        with open(INSTALLED_ADDONS_PATH, 'r') as file:
            existing_addons = json.load(file)
    except FileNotFoundError:
        existing_addons = []

    for existing_addon in existing_addons:
        if file_info["UID"] == existing_addon["UID"]:
            existing_addons.remove(existing_addon)

    existing_addons.append(file_info)

    with open(INSTALLED_ADDONS_PATH, 'w') as file:
        json.dump(existing_addons, file, indent=4)

def search_and_choose(search_text):
    found_addons_indices = search_json_file(search_text)

    if not found_addons_indices:
        print("ERROR! No AddOns found for " + search_text)
        return

    for num, i in enumerate(found_addons_indices[:5], start=1):
        info = get_file_info(i)
        name = info["UIName"]
        author = info["UIAuthorName"]
        downloads = info["UIDownloadTotal"]
        print(f"[{num}] {name} (by {author}, {downloads} downloads)")
    
    if len(found_addons_indices) > 5:
        print("[--- More AddOns were found, please enter a more specific name to get more precise results. ---]")

    if len(found_addons_indices) == 1:
        file_info = get_file_info(found_addons_indices[0])
    else:
        try:
            choice = int(input("Enter a number (1-5) to select an item for download: "))
            if not 1 <= choice <= 5:
                raise ValueError("Number out of range.")
        except ValueError as e:
            print(f"Invalid input: {e}")
            return
        file_info = get_file_info(found_addons_indices[choice - 1])

    print("Chosen Addon: " + file_info["UIName"])
    return file_info

def extract_dependencies(directory):
    file_path = os.path.join(ADDON_PATH, directory, directory + ".txt")
    
    dependencies = []
    
    with open(file_path, 'r') as file:
        for line in file:
            if line.startswith("## DependsOn:"):
                dependency_line = line[len("## DependsOn:"):].strip()
                dependencies_raw = dependency_line.split(' ')
                dependencies = []
                for d in dependencies_raw:
                    if d.startswith("Lib"):
                        d_clean = d.split('>')[0]
                        dependencies.append(d_clean)
                break

    return dependencies

def install(file_info):
    try:
        dir = download_and_extract_zip(file_info["UID"])
        file_info["Directory"] = dir
        store_installed_addon(file_info)

        if CONFIG_INSTALL_DEPS:
            deps = extract_dependencies(dir)
            print("Checking dependencies, found: ")
            print(deps)
            for dep in deps:
                # TODO:
                # 1. check if "dep" is a directory under "dir", if yes, continue -- some libs are only delivered with the respective addon
                # 2. check if "dep" is a directory under ADDON_PATH, if yes, continue
                file_info = search_and_choose(dep)
                if file_info == None:
                    continue
                dir = download_and_extract_zip(file_info["UID"])
                file_info["Directory"] = dir
                store_installed_addon(file_info)

    except Exception as e:
        print(f"An error occurred: {e}")

def remove(file_info):
    try:
        with open(INSTALLED_ADDONS_PATH, 'r') as file:
            existing_addons = json.load(file)
    except FileNotFoundError:
        existing_addons = []

    for existing_addon in existing_addons:
        if file_info["UID"] == existing_addon["UID"]:
            try:
                dir = os.path.join(ADDON_PATH, str(existing_addon["Directory"]))
                shutil.rmtree(dir)
            except FileNotFoundError:
                print("Addon Path not found. Deleting entry in Database.")

            existing_addons.remove(existing_addon)
            with open(INSTALLED_ADDONS_PATH, 'w') as file:
                json.dump(existing_addons, file, indent=4)
            
            print("Deleted!")
            return
    
    print("This AddOn is not installed. You can only remove AddOns you have installed. If this error message appears althogh the AddOn is installed, try deleting its folder.")

def main():
    if len(sys.argv) < 2:
        print(f"Usage: python {sys.argv[0]} [install/remove <search_text> / update]")
        return

    if sys.argv[1] == "update":
        download_filelist()
        update()
    elif sys.argv[1] == "install":
        if len(sys.argv) != 3:
            print(f"Usage: python {sys.argv[0]} [install/remove <search_text> / update]")
            return
        download_filelist()
        search_text = sys.argv[2]
        file_info = search_and_choose(search_text)
        install(file_info)
    elif sys.argv[1] == "remove":
        if len(sys.argv) != 3:
            print(f"Usage: python {sys.argv[0]} [install/remove <search_text> / update]")
            return
        search_text = sys.argv[2]
        file_info = search_and_choose(search_text)
        remove(file_info)
    else:
        print(f"Usage: python {sys.argv[0]} [install/remove <search_text> / update]")

if __name__ == "__main__":
    main()
    #update()
