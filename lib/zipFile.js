const ZipEntry = require("./zipEntry");
const Headers = require("./headers");
const Utils = require("./util");

module.exports = function (/*Buffer|null*/ inBuffer, /** object */ options) {
    var entryList = [],
        entryTable = {},
        _comment = Buffer.alloc(0),
        mainHeader = new Headers.MainHeader(),
        loadedEntries = false;
    var password = null;

    // assign options
    const opts = options;

    const { noSort, decoder } = opts;

    if (inBuffer) {
        // is a memory buffer
        readMainHeader(opts.readEntries);
    } else {
        // none. is a new file
        loadedEntries = true;
    }

    function iterateEntries(callback) {
        const totalEntries = mainHeader.diskEntries; // total number of entries
        let index = mainHeader.offset; // offset of first CEN header

        for (let i = 0; i < totalEntries; i++) {
            let tmp = index;
            const entry = new ZipEntry(opts, inBuffer);

            entry.header = inBuffer.slice(tmp, (tmp += Utils.Constants.CENHDR));
            entry.entryName = inBuffer.slice(tmp, (tmp += entry.header.fileNameLength));

            index += entry.header.centralHeaderSize;

            callback(entry);
        }
    }

    function readEntries() {
        loadedEntries = true;
        entryTable = {};
        if (mainHeader.diskEntries > (inBuffer.length - mainHeader.offset) / Utils.Constants.CENHDR) {
            throw new Error(Utils.Errors.DISK_ENTRY_TOO_LARGE);
        }
        entryList = new Array(mainHeader.diskEntries); // total number of entries
        var index = mainHeader.offset; // offset of first CEN header
        for (var i = 0; i < entryList.length; i++) {
            var tmp = index,
                entry = new ZipEntry(opts, inBuffer);
            entry.header = inBuffer.slice(tmp, (tmp += Utils.Constants.CENHDR));

            entry.entryName = inBuffer.slice(tmp, (tmp += entry.header.fileNameLength));

            if (entry.header.extraLength) {
                entry.extra = inBuffer.slice(tmp, (tmp += entry.header.extraLength));
            }

            if (entry.header.commentLength) entry.comment = inBuffer.slice(tmp, tmp + entry.header.commentLength);

            index += entry.header.centralHeaderSize;

            entryList[i] = entry;
            entryTable[entry.entryName] = entry;
        }
    }

    function readMainHeader(/*Boolean*/ readNow) {
        var i = inBuffer.length - Utils.Constants.ENDHDR, // END header size
            max = Math.max(0, i - 0xffff), // 0xFFFF is the max zip file comment length
            n = max,
            endStart = inBuffer.length,
            endOffset = -1, // Start offset of the END header
            commentEnd = 0;

        // option to search header form entire file
        const trailingSpace = typeof opts.trailingSpace === "boolean" ? opts.trailingSpace : false;
        if (trailingSpace) max = 0;

        for (i; i >= n; i--) {
            if (inBuffer[i] !== 0x50) continue; // quick check that the byte is 'P'
            if (inBuffer.readUInt32LE(i) === Utils.Constants.ENDSIG) {
                // "PK\005\006"
                endOffset = i;
                commentEnd = i;
                endStart = i + Utils.Constants.ENDHDR;
                // We already found a regular signature, let's look just a bit further to check if there's any zip64 signature
                n = i - Utils.Constants.END64HDR;
                continue;
            }

            if (inBuffer.readUInt32LE(i) === Utils.Constants.END64SIG) {
                // Found a zip64 signature, let's continue reading the whole zip64 record
                n = max;
                continue;
            }

            if (inBuffer.readUInt32LE(i) === Utils.Constants.ZIP64SIG) {
                // Found the zip64 record, let's determine it's size
                endOffset = i;
                endStart = i + Utils.readBigUInt64LE(inBuffer, i + Utils.Constants.ZIP64SIZE) + Utils.Constants.ZIP64LEAD;
                break;
            }
        }

        if (endOffset == -1) throw new Error(Utils.Errors.INVALID_FORMAT);

        mainHeader.loadFromBinary(inBuffer.slice(endOffset, endStart));
        if (mainHeader.commentLength) {
            _comment = inBuffer.slice(commentEnd + Utils.Constants.ENDHDR);
        }
        if (readNow) readEntries();
    }

    function sortEntries() {
        if (entryList.length > 1 && !noSort) {
            entryList.sort((a, b) => a.entryName.toLowerCase().localeCompare(b.entryName.toLowerCase()));
        }
    }

    return {
        /**
         * Returns an array of ZipEntry objects existent in the current opened archive
         * @return Array
         */
        get entries() {
            if (!loadedEntries) {
                readEntries();
            }
            return entryList;
        },

        /**
         * Archive comment
         * @return {String}
         */
        get comment() {
            return decoder.decode(_comment);
        },
        set comment(val) {
            _comment = Utils.toBuffer(val, decoder.encode);
            mainHeader.commentLength = _comment.length;
        },

        getEntryCount: function () {
            if (!loadedEntries) {
                return mainHeader.diskEntries;
            }

            return entryList.length;
        },

        forEach: function (callback) {
            if (!loadedEntries) {
                iterateEntries(callback);
                return;
            }

            entryList.forEach(callback);
        },

        /**
         * Returns a reference to the entry with the given name or null if entry is inexistent
         *
         * @param entryName
         * @return ZipEntry
         */
        getEntry: function (/*String*/ entryName) {
            if (!loadedEntries) {
                readEntries();
            }
            return entryTable[entryName] || null;
        },

        /**
         * Adds the given entry to the entry list
         *
         * @param entry
         */
        setEntry: function (/*ZipEntry*/ entry) {
            if (!loadedEntries) {
                readEntries();
            }
            entryList.push(entry);
            entryTable[entry.entryName] = entry;
            mainHeader.totalEntries = entryList.length;
        },

        /**
         * Removes the entry with the given name from the entry list.
         *
         * If the entry is a directory, then all nested files and directories will be removed
         * @param entryName
         */
        deleteEntry: function (/*String*/ entryName) {
            if (!loadedEntries) {
                readEntries();
            }
            var entry = entryTable[entryName];
            if (entry && entry.isDirectory) {
                var _self = this;
                this.getEntryChildren(entry).forEach(function (child) {
                    if (child.entryName !== entryName) {
                        _self.deleteEntry(child.entryName);
                    }
                });
            }
            entryList.splice(entryList.indexOf(entry), 1);
            delete entryTable[entryName];
            mainHeader.totalEntries = entryList.length;
        },

        /**
         *  Iterates and returns all nested files and directories of the given entry
         *
         * @param entry
         * @return Array
         */
        getEntryChildren: function (/*ZipEntry*/ entry) {
            if (!loadedEntries) {
                readEntries();
            }
            if (entry && entry.isDirectory) {
                const list = [];
                const name = entry.entryName;
                const len = name.length;

                entryList.forEach(function (zipEntry) {
                    if (zipEntry.entryName.startsWith(name)) {
                        list.push(zipEntry);
                    }
                });
                return list;
            }
            return [];
        },

        /**
         * Returns the zip file
         *
         * @return Buffer
         */
        compressToBuffer: function () {
            if (!loadedEntries) {
                readEntries();
            }
            sortEntries();

            const dataBlock = [];
            const headerBlocks = [];
            let totalSize = 0;
            let dindex = 0;

            mainHeader.size = 0;
            mainHeader.offset = 0;

            for (const entry of entryList) {
                // compress data and set local and entry header accordingly. Reason why is called first
                const compressedData = entry.getCompressedData();
                entry.header.offset = dindex;

                // 1. construct local header
                const localHeader = entry.packLocalHeader();

                // 2. offsets
                const dataLength = localHeader.length + compressedData.length;
                dindex += dataLength;

                // 3. store values in sequence
                dataBlock.push(localHeader);
                dataBlock.push(compressedData);

                // 4. construct central header
                const centralHeader = entry.packCentralHeader();
                headerBlocks.push(centralHeader);
                // 5. update main header
                mainHeader.size += centralHeader.length;
                totalSize += dataLength + centralHeader.length;
            }

            totalSize += mainHeader.mainHeaderSize; // also includes zip file comment length
            // point to end of data and beginning of central directory first record
            mainHeader.offset = dindex;

            dindex = 0;
            const outBuffer = Buffer.alloc(totalSize);
            // write data blocks
            for (const content of dataBlock) {
                content.copy(outBuffer, dindex);
                dindex += content.length;
            }

            // write central directory entries
            for (const content of headerBlocks) {
                content.copy(outBuffer, dindex);
                dindex += content.length;
            }

            // write main header
            const mh = mainHeader.toBinary();
            if (_comment) {
                _comment.copy(mh, Utils.Constants.ENDHDR); // add zip file comment
            }
            mh.copy(outBuffer, dindex);

            // Since we update entry and main header offsets,
            // they are no longer valid and we have to reset content
            // (Issue 64)

            inBuffer = outBuffer;
            loadedEntries = false;

            return outBuffer;
        },

        toAsyncBuffer: function (/*Function*/ onSuccess, /*Function*/ onFail, /*Function*/ onItemStart, /*Function*/ onItemEnd) {
            try {
                if (!loadedEntries) {
                    readEntries();
                }
                sortEntries();

                const dataBlock = [];
                const centralHeaders = [];
                let totalSize = 0;
                let dindex = 0;

                mainHeader.size = 0;
                mainHeader.offset = 0;

                const compress2Buffer = function (entryLists) {
                    if (entryLists.length > 0) {
                        const entry = entryLists.shift();
                        const name = entry.entryName + entry.extra.toString();
                        if (onItemStart) onItemStart(name);
                        entry.getCompressedDataAsync(function (compressedData) {
                            if (onItemEnd) onItemEnd(name);
                            entry.header.offset = dindex;

                            // 1. construct local header
                            const localHeader = entry.packLocalHeader();

                            // 2. offsets
                            const dataLength = localHeader.length + compressedData.length;
                            dindex += dataLength;

                            // 3. store values in sequence
                            dataBlock.push(localHeader);
                            dataBlock.push(compressedData);

                            // central header
                            const centalHeader = entry.packCentralHeader();
                            centralHeaders.push(centalHeader);
                            mainHeader.size += centalHeader.length;
                            totalSize += dataLength + centalHeader.length;

                            compress2Buffer(entryLists);
                        });
                    } else {
                        totalSize += mainHeader.mainHeaderSize; // also includes zip file comment length
                        // point to end of data and beginning of central directory first record
                        mainHeader.offset = dindex;

                        dindex = 0;
                        const outBuffer = Buffer.alloc(totalSize);
                        dataBlock.forEach(function (content) {
                            content.copy(outBuffer, dindex); // write data blocks
                            dindex += content.length;
                        });
                        centralHeaders.forEach(function (content) {
                            content.copy(outBuffer, dindex); // write central directory entries
                            dindex += content.length;
                        });

                        const mh = mainHeader.toBinary();
                        if (_comment) {
                            _comment.copy(mh, Utils.Constants.ENDHDR); // add zip file comment
                        }

                        mh.copy(outBuffer, dindex); // write main header

                        // Since we update entry and main header offsets, they are no
                        // longer valid and we have to reset content using our new buffer
                        // (Issue 64)

                        inBuffer = outBuffer;
                        loadedEntries = false;

                        onSuccess(outBuffer);
                    }
                };

                compress2Buffer(Array.from(entryList));
            } catch (e) {
                onFail(e);
            }
        }
    };
};
