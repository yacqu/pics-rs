


![alt text](sample.png)

1. On first scroll zoom the image jumps/jitters, after scolling starts its fine
2. The bg color is black, should match the same color as the header and footer
3. When pressing certain buttons the app starts lagging very badly
    - When I press just the copy button it displays the loading spinner for 2-3 seconds and then the app becomes unresponsive 
    - When I press crop, the box appears and then it lets me properly drag the box and resize it around, but when I press the crop button the image does not actually crop in the preview
    - If i hit copy of the cropped image, it will copy the cropped image properly even though the preview does not show the cropped image
4. There is no logging to the console from the rust side, so i cannot observe any of the performance in the console. 
    - We need targetted logging in critical areas of the code to see errors, and also performance of certain functions. For example, when the copy button is pressed, we need to log how long it takes to copy the image to the clipboard.
    - Need to log the time to open a folder, render an image, render the gallery, and copy an image to the clipboard.
    ex:
    ```log
    [HH:MM:SS] [INFO] [gallery.rs:scan_folder] Scanning folder took 2.3 seconds
    ```
5. When I click the folder button before it does anything it shows a loader for 10+ seconds
    - same behavior when scrolling through the gallery, 
    - The issue is less noticable on the second open of the same folder

6. In the gallery view the images are not aligned properly, they are all over the place and not in a grid. The images should be aligned in a grid with equal spacing between them.
they should all be in the same size, and the spacing between them should be equal. 
    - when i select a particular image it should be displayed in the preview area, and the gallery should be scrolled to the top of the selected image.