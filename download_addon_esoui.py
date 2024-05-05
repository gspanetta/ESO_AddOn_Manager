import requests
import zipfile
import os
import sys
import json
from bs4 import BeautifulSoup

ADDON_PATH = "."

def fetch_addons(searchtext):
    url = "https://www.esoui.com/downloads/search.php"
    data = {'search': searchtext}
    headers = {
        'Content-Type': 'application/x-www-form-urlencoded',
        'Cookie': 'bblastactivity=0; bblastvisit=1714817929; bbsessionhash=42115dc8cb91a9791bfef815e4a8ecf9'
    }

    response = requests.post(url, data=data, headers=headers)

    if response.status_code != 200:
        print(f"Failed to retrieve data: {response.status_code}")
        return []
    
    data = []

    soup = BeautifulSoup(response.text, 'html.parser')

    trs = soup.find_all('tr')
    for tr in trs:
        link = tr.find_all('a', class_='addonLink')
        if len(link) == 1:
            id = str(link[0].get('href')).split("-")[0].split("info")[1]
            name = link[0].text.strip()

            tds = tr.find_all('td')
            author = tds[2].text.strip()
            downloads = tds[4].text.strip()
    
            data.append([id, name, author, downloads])
    
    print(data)
    return data

def get_addon_infos(id):
    url = "https://www.esoui.com/downloads/info" + id
    response = requests.get(url)

    if response.status_code != 200:
        print(f"Failed to retrieve data: {response.status_code}")
        return None

    soup = BeautifulSoup(response.text, 'html.parser')
    version_div = soup.find('div', id='version')

    if not version_div:
        print("No 'version' div found on the page.")
        return None

    version = version_div.text.strip().split(' ')[1]
    infos = {}
    infos["Version"] = version

    info_tab = soup.find('div', id='tabB1')
    if not info_tab:
        print("info tab not found")
        return
    
    trs = info_tab.find_all('tr')

    for tr in trs:
        tds = tr.find_all('td')
        infos[tds[0].text.strip().rstrip(':')] = tds[1].text.strip()
    
    print(infos)

    return infos

def download_and_extract_zip(id):
    local_zip_path = "downloaded_file.zip"
    url = "https://www.esoui.com/downloads/getfile.php?id=" + id

    print("Download AddOn...")
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
    except zipfile.BadZipFile:
        raise Exception("Failed to extract, the downloaded file is not a valid zip file.")

    os.remove(local_zip_path)
    print("AddOn successfully installed.")

def main():
    if len(sys.argv) != 2:
        print(f"Usage: python {sys.argv[0]} <search_text>")
        return

    search_text = sys.argv[1]
    links_data = fetch_addons(search_text)

    if not links_data:
        print("No AddOns found for the given search text.")
        return

    for index, (id, name, author, downloads) in enumerate(links_data[:5], start=1):
        print(f"[{index}] {name} (by {author}, {downloads} downloads)")

    try:
        choice = int(input("Enter a number (1-5) to select an item for download: "))
        if not 1 <= choice <= 5:
            raise ValueError("Number out of range.")
    except ValueError as e:
        print(f"Invalid input: {e}")
        return

    try:
        download_and_extract_zip(links_data[choice - 1][0])

    except Exception as e:
        print(f"An error occurred: {e}")

if __name__ == "__main__":
    #main()
    fetch_addons("Light Attack Helper")